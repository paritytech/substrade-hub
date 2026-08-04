/**
 * Host account + signer via `@parity/product-sdk-signer`. `SignerManager.getSigner()` returns a PAPI
 * `PolkadotSigner` — the same type the wallet store already holds and `submitReviveCall` consumes — so
 * the host path reuses the existing order flow (see stores/wallet `connectHost` + lib/contract).
 */
import { SignerManager, type SignerAccount, type SignerState } from "@parity/product-sdk-signer";
import type { PolkadotSigner } from "polkadot-api";

let manager: SignerManager | null = null;

/**
 * Lazily create the host SignerManager. Product identity = `VITE_PRODUCT_ACCOUNT_ID`, else the current
 * host (`localhost:PORT` in dev; the `.dot` / `dev-dot.li` domain once deployed).
 */
function getManager(): SignerManager {
  if (!manager) {
    const identity =
      (import.meta.env.VITE_PRODUCT_ACCOUNT_ID as string | undefined) ??
      (typeof window !== "undefined" ? window.location.host : undefined);
    manager = new SignerManager({ ss58Prefix: 42, dappName: identity });
  }
  return manager;
}

export type { SignerAccount, SignerState };

/** Connect to the host and return the available product accounts. */
export async function connectHostAccounts(): Promise<SignerAccount[]> {
  const res = await getManager().connect();
  if (!res.ok) throw new Error(res.error.message || "Failed to connect to the Polkadot host");
  return res.value;
}

/** Select an account by SS58 address (required before `getHostSigner`). */
export function selectHostAccount(address: string): SignerAccount {
  const res = getManager().selectAccount(address);
  if (!res.ok) throw new Error(res.error.message || "Failed to select the account");
  return res.value;
}

/** The host-provided PAPI signer for the selected account. */
export function getHostSigner(): PolkadotSigner {
  const signer = getManager().getSigner();
  if (!signer) throw new Error("No host signer — connect and select an account first");
  return signer;
}

export function subscribeHostState(cb: (s: SignerState) => void): () => void {
  return getManager().subscribe(cb);
}

export function getHostState(): SignerState {
  return getManager().getState();
}

export function disconnectHost(): void {
  getManager().disconnect();
}
