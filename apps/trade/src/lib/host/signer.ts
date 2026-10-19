/**
 * Host account + signer via `@parity/product-sdk-signer`. `SignerManager.getSigner()` returns a PAPI
 * `PolkadotSigner` — the same type the wallet store already holds and `submitReviveCall` consumes — so
 * the host path reuses the existing order flow (see stores/wallet `connectHost` + lib/contract).
 */
import { SignerManager, type SignerAccount, type SignerState } from "@parity/product-sdk-signer";
import { formatHostError, getAccountsProvider } from "@parity/product-sdk-host";
import type { PolkadotSigner } from "polkadot-api";
import { activeChain } from "../../config/chains";
import { withTimeout } from "../timeout";
import { UserFacingError } from "../user-errors";

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
    });
  }
  return manager;
}

export type { SignerAccount, SignerState };

/** How long a host connect may take before the app gives up and lets the user retry. */
export const CONNECT_TIMEOUT_MS = 30_000;

let connecting: Promise<SignerAccount[]> | undefined;

/**
 * Connect to the host and return the available product accounts. Concurrent callers (the connect modal
 * and the sign-in listener in `use-host-reconnect`) share one attempt, since a second `connect()` would
 * cancel the one in flight. A host that does not answer within `CONNECT_TIMEOUT_MS` fails the attempt, so
 * the next call starts a fresh one.
 */
export function connectHostAccounts(): Promise<SignerAccount[]> {
  connecting ??= withTimeout(
    (async () => {
      const res = await getManager().connect();
      if (!res.ok) throw new Error(res.error.message || "Failed to connect to the Polkadot host");
      return res.value;
    })(),
    CONNECT_TIMEOUT_MS,
    () => {
      throw new UserFacingError("The Polkadot host did not respond. Try again.");
    },
  ).finally(() => {
    connecting = undefined;
  });
  return connecting;
}

/** Shown by the host on its sign-in screen. */
const LOGIN_REASON = "Connect SubsTrade Hub to trade with your Polkadot account.";

/**
 * Ask the host to sign the user in, for when it has no session to derive the app's account from. The host
 * shows its own sign-in screen: on a dot.li gateway, a QR code to scan with the Polkadot app. Resolves to
 * whether the user is now signed in; throws when the host is unavailable or the request fails.
 */
export async function requestHostLogin(): Promise<boolean> {
  const provider = await getAccountsProvider();
  if (!provider) throw new Error("The Polkadot host is not available.");
  return provider.requestLogin(LOGIN_REASON).match(
    (outcome) => outcome !== "Rejected",
    (error) => {
      throw new Error(`Host sign-in failed: ${formatHostError(error)}`);
    },
  );
}

/** Bound on the username lookup, which only decorates the account and never blocks it. */
const USERNAME_TIMEOUT_MS = 10_000;

/**
 * The signed-in user's username (`getUserId().primaryUsername`), or `null` when the host has none, fails
 * or does not answer in time, so the caller falls back to the address.
 */
export async function getHostUsername(): Promise<string | null> {
  try {
    const provider = await getAccountsProvider();
    if (!provider) return null;
    const lookup = provider.getUserId().match(
      (id) => id.primaryUsername.trim(),
      () => "",
    );
    return (await withTimeout(lookup, USERNAME_TIMEOUT_MS, () => "")) || null;
  } catch {
    return null;
  }
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
