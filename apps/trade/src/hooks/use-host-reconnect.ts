import { useEffect } from "react";
import { getAccountsProvider } from "@parity/product-sdk-host";
import { isInHost } from "../lib/host/detect";
import {
  connectHostAccounts,
  selectHostAccount,
  getHostSigner,
  subscribeHostState,
  getHostState,
} from "../lib/host/signer";
import { hostSyncAction } from "../lib/host/sync";
import { resetContractAllowanceStatus } from "../lib/host/allowances";
import { ss58ToOriginAccount } from "../lib/account";
import { useWalletStore } from "../stores/wallet";
import type { SignerState } from "../lib/host/signer";

/**
 * Keep the wallet store in sync with the host signer session for its whole lifetime (Task 2's
 * `subscribeAccounts` requirement): reflects SDK auto-reconnect, account switches, and disconnects, not
 * just the one-shot connect on load. `connectHost`/`disconnect` are guarded (see `hostSyncAction`) so
 * redundant emissions are no-ops. Allowance provisioning is not done here — it runs in the SignerManager
 * `onConnect` on every (re)connect. Best-effort and a no-op outside a host.
 */
export function useHostReconnect(): void {
  useEffect(() => {
    if (!isInHost()) return;
    let cancelled = false;

    const apply = (state: SignerState) => {
      if (cancelled) return;
      // Leaving "connected" (disconnect, reconnecting, host gone) invalidates the session's allowance:
      // reset the gate so a stale grant can't authorize a write and any pending gated write is rejected.
      // A fresh onConnect on the next "connected" re-provisions.
      if (state.status !== "connected") resetContractAllowanceStatus();
      const store = useWalletStore.getState();
      const action = hostSyncAction(state, { accountType: store.accountType, ss58: store.ss58 });
      if (action.type === "disconnect") {
        store.disconnect();
        return;
      }
      if (action.type === "connect") {
        try {
          store.connectHost({
            ss58: action.account.address,
            h160: action.account.h160Address as `0x${string}`,
            originAccount: ss58ToOriginAccount(action.account.address),
            signer: getHostSigner(),
          });
        } catch {
          // Signer not ready for this emission; a later one carries it.
        }
      }
    };

    // Subscribe first so no state change between connect and subscribe is missed.
    const unsubscribe = subscribeHostState(apply);

    // Establish the session (subscribing alone does not connect). connect() triggers onConnect
    // (allowance) and state emissions that `apply` turns into store updates; select the first account if
    // the SDK restored none, then reconcile the current state once.
    // Overlapping calls share one connect attempt (see connectHostAccounts).
    const establish = async () => {
      try {
        const accounts = await connectHostAccounts();
        if (cancelled || !accounts.length) return;
        if (!getHostState().selectedAccount) selectHostAccount(accounts[0]!.address);
        apply(getHostState());
      } catch {
        // No host session yet: stay disconnected until the user signs in or connects.
      }
    };
    void establish();

    // A user who signs in to the host after the app loaded gets no account from the first attempt, since
    // the host has no session to derive it from yet, and the signer SDK only reacts to a session that
    // drops. So follow the host's own sign-in status and connect again once it reports a session.
    let stopFollowingSignIn: (() => void) | undefined;
    void getAccountsProvider()
      .then((provider) => {
        if (cancelled || !provider) return;
        const sub = provider.subscribeAccountConnectionStatus((signIn) => {
          if (signIn === "Connected" && useWalletStore.getState().accountType !== "host") void establish();
        });
        stopFollowingSignIn = typeof sub === "function" ? sub : () => sub.unsubscribe();
      })
      .catch(() => {
        // Without the status feed, connecting from the wallet modal still works.
      });

    return () => {
      cancelled = true;
      unsubscribe();
      stopFollowingSignIn?.();
    };
  }, []);
}
