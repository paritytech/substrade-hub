/**
 * A non-sensitive hint persisted to localStorage so a Substrate connection can be re-established on
 * reload. NEVER stores the signer — only the extension name and the (public) derived addresses. The
 * signer is re-obtained from the extension on reconnect.
 */
export interface WalletHint {
  extensionName: string;
  ss58: string;
  h160: `0x${string}`;
  originAccount: `0x${string}`;
}

const KEY = "substrate-wallet-hint";

export function saveWalletHint(hint: WalletHint): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(hint));
  } catch {
    /* storage unavailable — reconnect simply won't be offered */
  }
}

export function loadWalletHint(): WalletHint | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const h = JSON.parse(raw) as Partial<WalletHint>;
    if (h.extensionName && h.ss58 && h.h160 && h.originAccount) return h as WalletHint;
    return null;
  } catch {
    return null;
  }
}

export function clearWalletHint(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
}
