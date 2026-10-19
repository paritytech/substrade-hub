import { type PolkadotSigner, type SS58String, type SizedHex } from "polkadot-api";
import { fromHex } from "polkadot-api/utils";
import type { Abi } from "viem";
import { getTypedApi } from "./client";
import { revertError } from "./errors";
import { UserFacingError } from "./user-errors";
import {
  submitAndWatch,
  TxDispatchError,
  type TxError,
  TxSigningRejectedError,
  TxTimeoutError,
  TxValidityError,
  type TxStatus,
} from "@parity/product-sdk-tx";
import type { TxStep } from "./tx-progress";

// Headroom over the dry-run estimates. ref_time is far below its per-extrinsic limit, so it gets 2x.
// proof_size is the limit an order meets first (about 1 MB per fill, 8 MiB per extrinsic), so it gets
// 10%: doubling it rejected orders crossing four or more price levels that would have fitted. Both are
// capped at what one extrinsic may use. Storage deposit does NOT affect block/PoV limits and the
// dry-run under-estimates it badly on storage-churning paths (e.g. a fill that removes a price level via
// the RedBlackTree delegatecall), so give it a generous buffer — otherwise those trades revert on
// execution while passing the dry-run. Verified: this order needed >3x storage.
const REF_TIME_BUFFER_PERCENT = 200n;
const PROOF_SIZE_BUFFER_PERCENT = 110n;
const STORAGE_BUFFER = 10n;
/**
 * What a `Revive.call` itself adds to its weight limit (17.5 KB of proof measured on paseo-v2), plus
 * the transaction's size: the limit must leave this room under the per-extrinsic maximum.
 */
const EXTRINSIC_MARGIN = { ref_time: 10_000_000_000n, proof_size: 64n * 1024n };

type Weight = { ref_time: bigint; proof_size: bigint };

/**
 * The weight limit for a call needing `required`: the buffered estimate, capped at what one extrinsic
 * may use (`max` less `EXTRINSIC_MARGIN`). Throws a user error when the estimate alone does not fit.
 */
export function weightLimit(required: Weight, max: Weight): Weight {
  const cap = {
    ref_time: max.ref_time - EXTRINSIC_MARGIN.ref_time,
    proof_size: max.proof_size - EXTRINSIC_MARGIN.proof_size,
  };
  if (required.ref_time > cap.ref_time || required.proof_size > cap.proof_size) {
    throw new UserFacingError("This order crosses too many price levels for one transaction — place a smaller order", {
      cause: `needs ${required.ref_time} ref_time and ${required.proof_size} proof_size; one extrinsic allows ${cap.ref_time} and ${cap.proof_size}`,
    });
  }
  const buffered = (value: bigint, percent: bigint, limit: bigint) => {
    const v = (value * percent) / 100n;
    return v < limit ? v : limit;
  };
  return {
    ref_time: buffered(required.ref_time, REF_TIME_BUFFER_PERCENT, cap.ref_time),
    proof_size: buffered(required.proof_size, PROOF_SIZE_BUFFER_PERCENT, cap.proof_size),
  };
}

let maxExtrinsic: Promise<Weight> | undefined;

/** What one normal extrinsic may use on this chain (`System.BlockWeights`), read once; a failed read is retried. */
function maxExtrinsicWeight(): Promise<Weight> {
  maxExtrinsic ??= getTypedApi()
    .constants.System.BlockWeights()
    .then((w) => w.per_class.normal.max_extrinsic ?? w.max_block)
    .catch((e: unknown) => {
      maxExtrinsic = undefined;
      throw e;
    });
  return maxExtrinsic;
}

/**
 * Reject a submission that is never included, so the UI can't hang forever on a dropped tx.
 * Asset Hub blocks are ~2s, so inclusion normally takes a few seconds; this is a generous safety
 * net (~15 blocks of headroom) to avoid false timeouts on a brief RPC hiccup, not the happy path.
 */
const INCLUSION_TIMEOUT_MS = 30_000;

/** The revert flag is bit 0 of an ExecReturnValue `flags` bitfield. */
export function isRevert(flags: number): boolean {
  return (flags & 1) === 1;
}

/**
 * The names along a chain error's nested `{ type, value }` chain, e.g. a Module error gives
 * Module, Revive, StorageDepositLimitExhausted. Unwraps PAPI errors that carry the shape under `.error`
 * or JSON-encode it in an Error message. Empty for anything else.
 */
function errorPath(err: unknown): string[] {
  let e: unknown = err;
  if (err instanceof Error) {
    try {
      e = JSON.parse(err.message);
    } catch {
      return [];
    }
  }
  if (e && typeof e === "object" && "error" in e && (e as { error?: unknown }).error) {
    e = (e as { error: unknown }).error;
  }
  const path: string[] = [];
  let cur: unknown = e;
  while (cur && typeof cur === "object" && typeof (cur as { type?: unknown }).type === "string") {
    path.push((cur as { type: string }).type);
    cur = (cur as { value?: unknown }).value;
  }
  return path;
}

/** Chain errors the user can act on, by a name in the error's path; undefined for the rest. */
const NOT_ENOUGH_FUNDS = ["Payment", "FundsUnavailable", "InsufficientBalance", "StorageDepositNotEnoughFunds"];
function userChainError(path: string[]): string | undefined {
  if (path.some((name) => NOT_ENOUGH_FUNDS.includes(name))) {
    return "Not enough balance to pay for this transaction — add funds and try again";
  }
  if (path.includes("Stale") || path.includes("Future")) {
    return "A previous transaction is still pending — wait a moment and try again";
  }
  if (path.includes("BadProof")) {
    return "The network rejected your wallet's signature — try again, or use another wallet";
  }
  if (path.includes("AccountUnmapped")) {
    // Accounts are mapped when they are created, which funding the account does.
    return "This account is not set up on this network yet — add some native tokens to it, then try again";
  }
  return undefined;
}

/**
 * The error to throw for a chain failure: a `UserFacingError` when the user can act on it (see
 * `userChainError`), else a plain Error carrying the detail for the console.
 */
function chainError(err: unknown): Error {
  const detail = formatSubmitError(err);
  const user = userChainError(errorPath(err));
  return user ? new UserFacingError(user, { cause: detail }) : new Error(detail);
}

/**
 * Format a submission failure — a dispatch error (post-inclusion) OR a transaction-validity error
 * (pre-inclusion, e.g. `BadProof`) — into a short, human message. Unwraps PAPI errors that carry the
 * structured `{ type, value }` under `.error` or JSON-encode it in an Error message.
 */
export function formatSubmitError(err: unknown): string {
  if (err instanceof Error && errorPath(err).length === 0) return err.message;
  const path = errorPath(err);
  if (path.includes("BadProof"))
    return "Chain rejected the signature (BadProof) — the signed payload didn't match what the runtime expected. This is a wallet/runtime signing incompatibility, not an insufficient-balance error.";
  if (path.length) {
    const [outer, ...rest] = path;
    return `Transaction failed: ${outer}${rest.length ? ` (${rest.join(".")})` : ""}`;
  }
  return `Transaction failed: ${typeof err === "string" ? err : JSON.stringify(err)}`;
}

/** The error to throw for a product-sdk-tx failure. */
export function txError(e: TxError): Error {
  if (e instanceof TxTimeoutError) {
    return new UserFacingError(
      "The network didn't include the transaction in time — check your orders before trying again",
      { cause: e },
    );
  }
  if (e instanceof TxSigningRejectedError) return new UserFacingError("Signing was cancelled.", { cause: e });
  if (e instanceof TxValidityError) return chainError({ error: e.reason });
  if (e instanceof TxDispatchError) return chainError(e.dispatchError);
  return chainError(e);
}

/** The SDK's lifecycle statuses, as the steps the UI reports. Its "signing" fires once signed. */
const STEP_OF_STATUS: Partial<Record<TxStatus, TxStep>> = {
  signing: "signed",
  broadcasting: "submitted",
  "in-block": "in-block",
  finalized: "finalized",
};

/**
 * Sign + submit via `@parity/product-sdk-tx`, resolving on best-block INCLUSION (not finality) for UX
 * parity with the EVM receipt path. Rejects with a formatted message on any failure. `onProgress` keeps
 * receiving steps after it resolves, up to finality.
 */
async function submitAndAwaitInclusion(
  tx: Parameters<typeof submitAndWatch>[0],
  signer: PolkadotSigner,
  onProgress?: (step: TxStep) => void,
): Promise<{ txHash: string }> {
  const res = await submitAndWatch(tx, signer, {
    waitFor: "best-block",
    timeoutMs: INCLUSION_TIMEOUT_MS,
    onStatus: (status) => {
      const step = STEP_OF_STATUS[status];
      if (step) onProgress?.(step);
    },
  });
  if (!res.ok) throw txError(res.error);
  return { txHash: res.value.txHash };
}

/**
 * Probe whether the account is mapped and short-circuit if so. NOTE: live testing on Paseo AH shows
 * `map_account` is a **no-op** on this runtime and cannot map an unmapped account — an account must
 * already be mapped (auto-mapped at creation, or an EVM 0xEE account) or `Revive.call` reverts
 * `AccountUnmapped`. So the `map_account` fallback below only helps on runtimes where it works;
 * callers should surface an unmapped account to the user rather than assume this fixes it.
 */
export async function ensureMapped(
  h160: `0x${string}`,
  signer: PolkadotSigner,
): Promise<void> {
  const api = getTypedApi();
  const existing = await api.query.Revive.OriginalAccount.getValue(h160 as SizedHex<20>);
  if (existing != null) return; // already mapped
  try {
    // Same path as a contract call, so a cancelled signature or too little balance reads the same.
    await submitAndAwaitInclusion(api.tx.Revive.map_account(), signer);
  } catch (e) {
    const detail = e instanceof Error ? `${e.message} ${String(e.cause ?? "")}` : String(e);
    if (!/AccountAlreadyMapped/i.test(detail)) throw e;
  }
}

export interface ReviveCallParams {
  /** Contract ABI — only used to decode a revert reason from the dry-run. */
  abi: Abi;
  contractAddress: `0x${string}`;
  callData: `0x${string}`;
  /** Dry-run origin (the signer's SS58 account). */
  originSs58: string;
  signer: PolkadotSigner;
  /**
   * Native planck; 0 for local orders (#14). Cross-chain must convert from an 18-dp msg.value first
   * (nativeValue = ceil(evmValue / NativeToEthRatio)); the extrinsic value is native, not 18-dp.
   * NB: NativeToEthRatio = 10^(18 - nativeDecimals), and nativeDecimals is chain-specific
   * (Paseo/Polkadot = 10, Westend = 12) — derive it from the chain spec (see use-native-token),
   * do not assume 10.
   */
  value?: bigint;
  /** Reports the transaction's steps, from signed to finalized. */
  onProgress?: (step: TxStep) => void;
}

/**
 * Substrate write path: dry-run for gas + revert reason, then submit `Revive.call` as an extrinsic.
 * Returns a shape uniform with the EVM path so callers stay agnostic.
 */
export async function submitReviveCall(
  params: ReviveCallParams,
): Promise<{ txHash: string; status: "success" }> {
  const api = getTypedApi();
  const value = params.value ?? 0n;
  const data = fromHex(params.callData);
  const dest = params.contractAddress as SizedHex<20>;

  // 1. Dry-run: sizes weight + storage deposit AND surfaces contract reverts before we sign.
  //    ReviveApi.call lazily maps the origin, so this works even for an unmapped account.
  //    It runs at the best block: writes resolve on best-block inclusion, so a call that depends on
  //    the previous write (an order after its approve) would revert against the finalized state.
  const dry = await api.apis.ReviveApi.call(
    params.originSs58 as SS58String,
    dest,
    value,
    undefined, // gas_limit
    undefined, // storage_deposit_limit
    data,
    { at: "best" },
  );

  if (!dry.result.success) {
    // dispatch-level failure (fees, origin, etc.) — not a contract revert
    const user = userChainError(errorPath(dry.result.value));
    const detail = `dry-run failed: ${JSON.stringify(dry.result.value)}`;
    throw user ? new UserFacingError(user, { cause: detail }) : new Error(detail);
  }
  if (isRevert(dry.result.value.flags)) {
    // revertError reads `.value.data`, so wrap the ExecReturnValue accordingly
    throw revertError({ value: dry.result.value }, params.abi);
  }
  // A function call that requires ZERO weight means the destination has no contract code: the call is a
  // silent no-op that pallet-revive still reports as success (this is what a mis-recorded/undeployed
  // contract address looks like). Fail loudly instead of letting the UI toast a fake success.
  if (
    data.length > 0 &&
    dry.weight_required.ref_time === 0n &&
    dry.weight_required.proof_size === 0n
  ) {
    throw new Error(
      `No contract code at ${params.contractAddress}. The call would do nothing — check the deployed address.`,
    );
  }

  const depositLimit =
    dry.storage_deposit.type === "Charge" ? dry.storage_deposit.value * STORAGE_BUFFER : 0n;

  const tx = api.tx.Revive.call({
    dest,
    value,
    weight_limit: weightLimit(dry.weight_required, await maxExtrinsicWeight()),
    storage_deposit_limit: depositLimit,
    data,
  });

  // A raw DispatchError would not match usePlaceOrder's EVM formatOrderError, so
  // submitAndAwaitInclusion formats it into the thrown Error message.
  const { txHash } = await submitAndAwaitInclusion(tx, params.signer, params.onProgress);
  return { txHash, status: "success" };
}
