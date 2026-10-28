// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: © 2026 Parity Technologies
import { useEffect } from "react";
import { connectExtension, watchAccounts, isAccountPresent } from "../lib/substrate-wallet";
import { ensureExtensionMetadata } from "../lib/extension-metadata";
import { loadWalletHint, clearWalletHint } from "../lib/wallet-hint";
import { isInHost } from "../lib/host/detect";
import { useWalletStore } from "../stores/wallet";
import { ss58ToH160, ss58ToOriginAccount } from "../lib/account";

/**
 * On mount, re-establish a previously connected Substrate wallet from the persisted hint. The signer
 * is re-obtained from the extension (never persisted); the addresses are derived from the account
 * offline, so no runtime call is needed, and a hint whose addresses differ is dropped. Best-effort: clears the hint if the extension/account is unavailable.
 */
export function useWalletReconnect(): void {
  useEffect(() => {
    // In a host, useHostReconnect owns the wallet. Both hooks pass the initial `!accountType` check,
    // so if a stale extension hint is present inside a host they would race and the slower one would
    // overwrite the host connection. Browser reconnect stands down in host mode.
    if (isInHost()) return;
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
        // The hint is local storage: use its addresses only when they are the ones the account derives.
        if (hint.h160.toLowerCase() !== ss58ToH160(hint.ss58) || hint.originAccount.toLowerCase() !== ss58ToOriginAccount(hint.ss58)) {
          clearWalletHint();
          return;
        }
        // Re-register the chain's signed extensions so signing works this session too. Idempotent:
        // no prompt if the wallet already has them (e.g. approved on the original connect).
        await ensureExtensionMetadata(hint.extensionName);
        if (cancelled) return;
        useWalletStore.getState().connectSubstrate({
          extensionName: hint.extensionName,
          ss58: hint.ss58,
          h160: ss58ToH160(hint.ss58),
          originAccount: ss58ToOriginAccount(hint.ss58),
          signer: acc.txCreator,
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
