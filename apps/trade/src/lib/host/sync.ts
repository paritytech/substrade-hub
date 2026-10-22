// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: © 2026 Parity Technologies
import type { SignerAccount, SignerState } from "@parity/product-sdk-signer";

/**
 * What the wallet store should do given the latest host `SignerState`. Pure so it can be unit-tested
 * without React; the effect in `use-host-reconnect` applies it (obtaining the signer / calling the
 * store). Only the "host" account type is ever touched — an EVM/Substrate connection is left alone.
 */
export type HostSyncAction =
  | { type: "connect"; account: SignerAccount }
  | { type: "disconnect" }
  | { type: "noop" };

export function hostSyncAction(
  state: SignerState,
  current: { accountType: string | null; ss58: string | null },
): HostSyncAction {
  // A live EVM/Substrate connection is not ours to manage.
  if (current.accountType !== null && current.accountType !== "host") return { type: "noop" };

  const account = state.selectedAccount;
  const connected = state.status === "connected" && account != null;

  if (!connected) {
    // Host session dropped (disconnect, account removed, host gone): clear a stale host account.
    return current.accountType === "host" ? { type: "disconnect" } : { type: "noop" };
  }

  // Connected: make sure the store reflects the currently selected account (covers account switches
  // and the initial connect). No-op when it already matches, so redundant emissions are cheap.
  if (current.accountType === "host" && current.ss58 === account.address) return { type: "noop" };
  return { type: "connect", account };
}
