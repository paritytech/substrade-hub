/**
 * Host account + signer via `@parity/product-sdk-signer`. `SignerManager.getSigner()` returns a PAPI
 * `PolkadotSigner` — the same type the wallet store already holds and `submitReviveCall` consumes — so
 * the host path reuses the existing order flow (see stores/wallet `connectHost` + lib/contract).
 */
import { SignerManager, type SignerAccount, type SignerState } from "@parity/product-sdk-signer";
import type { PolkadotSigner } from "polkadot-api";

let manager: SignerManager | null = null;

/**
 * The registered DotNS product identity. The SDK appends `.dot` to non-local names, so this must
 * already end in `.dot` (used verbatim). Do NOT fall back to `window.location.host`: on the deployed
 * domain that is `substrade-hub.dot.li`, which the SDK turns into `substrade-hub.dot.li.dot` and then
 * resolves zero product accounts. `.env.example` is documentation only — Vite loads `.env`/`.env.local`,
 * not `.env.example` — so the default here (not an env file) is what makes a clean checkout work.
 */
const DEFAULT_PRODUCT_ID = "substrade-hub.dot";

/** Lazily create the host SignerManager. Product identity: `VITE_PRODUCT_ACCOUNT_ID`, else the default. */
function getManager(): SignerManager {
  if (!manager) {
    const configured = (import.meta.env.VITE_PRODUCT_ACCOUNT_ID as string | undefined)?.trim();
    const identity = configured && configured.length > 0 ? configured : DEFAULT_PRODUCT_ID;
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
