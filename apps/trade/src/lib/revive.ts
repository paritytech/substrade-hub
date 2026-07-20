import { type PolkadotSigner, type SS58String, type SizedHex } from "polkadot-api";
import { fromHex } from "polkadot-api/utils";
import type { Abi } from "viem";
import { getTypedApi } from "./client";
import { extractRevertReason } from "./errors";

/** Buffer applied to dry-run weights / storage deposit for headroom. */
const GAS_BUFFER = 2n;

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

/** Decode a Substrate dispatch error into a short human string. */
export function formatDispatchError(err: unknown): string {
  if (err && typeof err === "object") {
    const e = err as { type?: string; value?: { type?: string } };
    if (e.type) return `Transaction failed: ${e.type}${e.value?.type ? ` (${e.value.type})` : ""}`;
  }
  return `Transaction failed: ${JSON.stringify(err)}`;
}

interface WatchEvent {
  type?: string;
  txHash?: string;
  found?: boolean;
  ok?: boolean;
  dispatchError?: unknown;
  block?: { hash?: string };
}

type WatchableTx = {
  signSubmitAndWatch: (signer: PolkadotSigner) => {
    subscribe: (observer: {
      next: (ev: WatchEvent) => void;
      error: (err: unknown) => void;
    }) => { unsubscribe: () => void };
  };
};

/**
 * Sign + submit, resolving on best-block INCLUSION (not finality) for UX parity with the EVM receipt
 * path. Rejects on a dispatch error (formatted) or a subscription error. Event shapes follow PAPI's
 * `signSubmitAndWatch` and mirror t3rminal's proven handling.
 */
function signAndWatchInclusion(
  tx: WatchableTx,
  signer: PolkadotSigner,
): Promise<{ txHash: string; blockHash: string }> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let lastTxHash = "";
    // Defer unsubscribe so `sub` is bound even when an event arrives synchronously.
    const stop = () => queueMicrotask(() => {
      try {
        sub.unsubscribe();
      } catch {
        /* noop */
      }
    });
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      stop();
      reject(new Error("Transaction was not included within 30s — check the explorer and try again."));
    }, INCLUSION_TIMEOUT_MS);
    const sub = tx.signSubmitAndWatch(signer).subscribe({
      next(ev) {
        if (ev.txHash) lastTxHash = ev.txHash;
        if (ev.type === "txBestBlocksState" && ev.found && !settled) {
          settled = true;
          clearTimeout(timer);
          stop();
          if (ev.ok === false) reject(new Error(formatDispatchError(ev.dispatchError)));
          else resolve({ txHash: lastTxHash, blockHash: ev.block?.hash ?? "" });
        }
      },
      error(err) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      },
    });
  });
}

/**
 * Defensive probe: on Asset Hub accounts are auto-mapped (pallet-revive AutoMap=true), so this almost
 * always short-circuits. Retained for non-AutoMap runtimes / never-funded accounts. Idempotent.
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

  const depositLimit =
    dry.storage_deposit.type === "Charge" ? dry.storage_deposit.value * GAS_BUFFER : 0n;

  const tx = api.tx.Revive.call({
    dest,
    value,
    weight_limit: {
      ref_time: dry.weight_required.ref_time * GAS_BUFFER,
      proof_size: dry.weight_required.proof_size * GAS_BUFFER,
    },
    storage_deposit_limit: depositLimit,
    data,
  });

  // Resolve on best-block inclusion (not finality) for UX parity with the EVM receipt path. A raw
  // DispatchError would not match usePlaceOrder's EVM formatOrderError, so signAndWatchInclusion
  // formats it into the thrown Error message.
  const { txHash } = await signAndWatchInclusion(tx as unknown as WatchableTx, params.signer);
  return { txHash, status: "success" };
}
