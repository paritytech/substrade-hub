import { useEffect } from "react";
import { connectExtension, watchAccounts, isAccountPresent } from "../lib/substrate-wallet";
import { loadWalletHint, clearWalletHint } from "../lib/wallet-hint";
import { useWalletStore } from "../stores/wallet";

/**
 * On mount, re-establish a previously connected Substrate wallet from the persisted hint. The signer
 * is re-obtained from the extension (never persisted); the derived addresses come from the hint, so
 * no runtime call is needed. Best-effort: clears the hint if the extension/account is unavailable.
 */
export function useWalletReconnect(): void {
  useEffect(() => {
    const hint = loadWalletHint();
    if (!hint) return;
    if (useWalletStore.getState().accountType) return; // already connected this session

    let cancelled = false;
    void (async () => {
      try {
        const ext = await connectExtension(hint.extensionName);
        if (cancelled) return;
        const accounts = ext.getAccounts();
        const acc = accounts.find((a) => a.address === hint.ss58);
        if (!acc || !isAccountPresent(accounts, hint.ss58)) {
          clearWalletHint();
          return;
        }
        useWalletStore.getState().connectSubstrate({
          extensionName: hint.extensionName,
          ss58: hint.ss58,
          h160: hint.h160,
          originAccount: hint.originAccount,
          signer: acc.polkadotSigner,
        });
        watchAccounts(ext, hint.ss58, () => useWalletStore.getState().disconnect());
      } catch {
        clearWalletHint();
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);
}
