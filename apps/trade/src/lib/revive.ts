import { type PolkadotSigner, type SS58String, type SizedHex } from "polkadot-api";
import { fromHex } from "polkadot-api/utils";
import type { Abi } from "viem";
import { getTypedApi } from "./client";
import { extractRevertReason } from "./errors";
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

// Headroom over the dry-run estimates. Weight (ref_time/proof_size) is PoV-sensitive and counts against
// block limits, so keep its buffer modest. Storage deposit does NOT affect block/PoV limits and the
// dry-run under-estimates it badly on storage-churning paths (e.g. a fill that removes a price level via
// the RedBlackTree delegatecall), so give it a generous buffer — otherwise those trades revert on
// execution while passing the dry-run. Verified: this order needed >3x storage; 2x weight was ample.
const WEIGHT_BUFFER = 2n;
const STORAGE_BUFFER = 10n;

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
 * Format a submission failure — a dispatch error (post-inclusion) OR a transaction-validity error
 * (pre-inclusion, e.g. `BadProof`) — into a short, human message. Unwraps PAPI errors that carry the
 * structured `{ type, value }` under `.error` or JSON-encode it in an Error message.
 */
export function formatSubmitError(err: unknown): string {
  let e: unknown = err;
  // Our own thrown Errors have plain messages; PAPI validity errors may JSON-encode the shape.
  if (err instanceof Error) {
    try {
      e = JSON.parse(err.message);
    } catch {
      return err.message;
    }
  }
  if (e && typeof e === "object" && "error" in e && (e as { error?: unknown }).error) {
    e = (e as { error: unknown }).error;
  }
  // Walk the nested `{ type, value }` chain so we surface the full path, e.g. a Module error decodes to
  // Module -> Revive -> StorageDepositLimitExhausted, not just "Module (Revive)".
  const path: string[] = [];
  let cur: unknown = e;
  while (cur && typeof cur === "object" && typeof (cur as { type?: unknown }).type === "string") {
    path.push((cur as { type: string }).type);
    cur = (cur as { value?: unknown }).value;
  }
  if (path.includes("BadProof"))
    return "Chain rejected the signature (BadProof) — the signed payload didn't match what the runtime expected. This is a wallet/runtime signing incompatibility, not an insufficient-balance error.";
  if (path.length) {
    const [outer, ...rest] = path;
    return `Transaction failed: ${outer}${rest.length ? ` (${rest.join(".")})` : ""}`;
  }
  return `Transaction failed: ${typeof err === "string" ? err : JSON.stringify(err)}`;
}

/** Turn a product-sdk-tx failure into the short message the order UI shows. */
export function describeTxError(e: TxError): string {
  if (e instanceof TxTimeoutError) {
    return `Transaction was not included within ${INCLUSION_TIMEOUT_MS / 1000}s — check the explorer and try again.`;
  }
  if (e instanceof TxSigningRejectedError) return "Signing was cancelled.";
  // Validity errors (e.g. BadProof) arrive pre-inclusion; keep the structured payload so the BadProof
  // explanation in formatSubmitError still applies.
  if (e instanceof TxValidityError) return formatSubmitError({ error: e.reason });
  if (e instanceof TxDispatchError) return formatSubmitError(e.dispatchError);
  return formatSubmitError(e);
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
  if (!res.ok) throw new Error(describeTxError(res.error));
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
  const res = await api.tx.Revive.map_account().signAndSubmit(signer);
  if (!res.ok && !/AccountAlreadyMapped/i.test(JSON.stringify(res.dispatchError))) {
    throw new Error(`map_account failed: ${JSON.stringify(res.dispatchError)}`);
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
  const dry = await api.apis.ReviveApi.call(
    params.originSs58 as SS58String,
    dest,
    value,
    undefined, // gas_limit
    undefined, // storage_deposit_limit
    data,
  );

  if (!dry.result.success) {
    // dispatch-level failure (fees, origin, etc.) — not a contract revert
    throw new Error(`dry-run failed: ${JSON.stringify(dry.result.value)}`);
  }
  if (isRevert(dry.result.value.flags)) {
    // extractRevertReason reads `.value.data`, so wrap the ExecReturnValue accordingly
    throw new Error(extractRevertReason({ value: dry.result.value }, params.abi));
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
    weight_limit: {
      ref_time: dry.weight_required.ref_time * WEIGHT_BUFFER,
      proof_size: dry.weight_required.proof_size * WEIGHT_BUFFER,
    },
    storage_deposit_limit: depositLimit,
    data,
  });

  // A raw DispatchError would not match usePlaceOrder's EVM formatOrderError, so
  // submitAndAwaitInclusion formats it into the thrown Error message.
  const { txHash } = await submitAndAwaitInclusion(tx, params.signer, params.onProgress);
  return { txHash, status: "success" };
}
