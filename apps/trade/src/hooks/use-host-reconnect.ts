import { useEffect } from "react";
import { isInHost } from "../lib/host/detect";
import { connectHostAccounts, selectHostAccount, getHostSigner } from "../lib/host/signer";
import { ss58ToOriginAccount } from "../lib/account";
import { useWalletStore } from "../stores/wallet";

/**
 * In a Polkadot host, re-establish the product account on load (the host owns the session, so no
 * localStorage hint is kept). Restores the account + host signer into the store; does NOT re-request
 * allowances (that stays on the explicit connect flow). Best-effort and a no-op outside a host.
 */
export function useHostReconnect(): void {
  useEffect(() => {
    if (!isInHost()) return;
    if (useWalletStore.getState().accountType) return; // already connected this session

    let cancelled = false;
    void (async () => {
      try {
        const accounts = await connectHostAccounts();
        if (cancelled || !accounts.length) return;
        const acc = accounts[0]!;
        selectHostAccount(acc.address);
        const signer = getHostSigner();
        if (cancelled) return;
        useWalletStore.getState().connectHost({
          ss58: acc.address,
          h160: acc.h160Address as `0x${string}`,
          originAccount: ss58ToOriginAccount(acc.address),
          signer,
        });
      } catch {
        /* no host session yet — stay disconnected until the user connects */
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);
}
