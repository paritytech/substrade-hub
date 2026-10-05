/**
 * Host account + signer via `@parity/product-sdk-signer`. `SignerManager.getSigner()` returns a PAPI
 * `PolkadotSigner` — the same type the wallet store already holds and `submitReviveCall` consumes — so
 * the host path reuses the existing order flow (see stores/wallet `connectHost` + lib/contract).
 */
import { SignerManager, type SignerAccount, type SignerState } from "@parity/product-sdk-signer";
import type { PolkadotSigner } from "polkadot-api";
import { activeChain } from "../../config/chains";
import { provisionContractAllowance, resetContractAllowanceStatus } from "./allowances";

let manager: SignerManager | null = null;

/**
 * Lazily create the host SignerManager. The product identity is the network's dotNS name
 * (`networks.json`), passed fully qualified so the SDK uses it verbatim for `getProductAccount`. It must
 * equal the name the build is published under, or the host refuses to sign.
 */
function getManager(): SignerManager {
  if (!manager) {
    manager = new SignerManager({
      ss58Prefix: 42,
      dappName: activeChain.dotnsName,
      // Fires on the initial connect AND after every SDK auto-reconnect / fresh host session, so the
      // SmartContractAllowance + AutoSigning grants are (re-)provisioned whenever a session refreshes or
      // an allocation expires — something the one-shot reconnect hook cannot do. Best-effort: the SDK
      // logs a throw here and retries on the next reconnect. Already-granted resources come back
      // "Allocated" with no prompt, so this is a no-op on a warm reload.
      onConnect: async (_account, { requestResourceAllocation }) => {
        await provisionContractAllowance(requestResourceAllocation);
      },
    });
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
  resetContractAllowanceStatus();
  getManager().disconnect();
}
