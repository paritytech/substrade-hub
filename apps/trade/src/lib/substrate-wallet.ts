import {
  getInjectedExtensions,
  connectInjectedExtension,
  type InjectedExtension,
  type InjectedPolkadotAccount,
} from "polkadot-api/pjs-signer";

/** Names of injected Substrate extensions the browser exposes (Talisman / SubWallet / polkadot-js). */
export function listSubstrateExtensions(): string[] {
  return getInjectedExtensions();
}

/**
 * Connect to an injected extension and return its HANDLE. Use `ext.getAccounts()` for the account
 * list and `watchAccounts` to react to account/lock changes.
 */
export async function connectExtension(name: string): Promise<InjectedExtension> {
  return connectInjectedExtension(name);
}

/** Whether an SS58 address is still present in an account list (pure — unit-tested). */
export function isAccountPresent(accounts: InjectedPolkadotAccount[], address: string): boolean {
  return accounts.some((a) => a.address === address);
}

let currentUnsub: (() => void) | null = null;

/**
 * Watch an extension's accounts; call `onGone` if `address` disappears (account removed or the
 * extension locked). Replaces any previous watcher. Returns nothing — call `stopWatchingAccounts` to
 * cancel (e.g. on disconnect).
 */
export function watchAccounts(
  ext: InjectedExtension,
  address: string,
  onGone: () => void,
): void {
  stopWatchingAccounts();
  currentUnsub = ext.subscribe((accounts) => {
    if (!isAccountPresent(accounts, address)) onGone();
  });
}

export function stopWatchingAccounts(): void {
  currentUnsub?.();
  currentUnsub = null;
}
