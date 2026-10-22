// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: © 2026 Parity Technologies
import { describe, it, expect } from "vitest";
import { hostSyncAction } from "./sync";
import type { SignerAccount, SignerState } from "@parity/product-sdk-signer";

const ACC_A = { address: "5GrwA", h160Address: "0xaaaa" } as unknown as SignerAccount;
const ACC_B = { address: "5GrwB", h160Address: "0xbbbb" } as unknown as SignerAccount;

const state = (over: Partial<SignerState>): SignerState =>
  ({ status: "connected", accounts: [], selectedAccount: null, ...over }) as SignerState;

describe("hostSyncAction", () => {
  it("connects the store to the selected account when the host is connected", () => {
    const a = hostSyncAction(state({ selectedAccount: ACC_A }), { accountType: null, ss58: null });
    expect(a).toEqual({ type: "connect", account: ACC_A });
  });

  it("is a no-op when the store already holds the selected host account", () => {
    const a = hostSyncAction(state({ selectedAccount: ACC_A }), {
      accountType: "host",
      ss58: "5GrwA",
    });
    expect(a).toEqual({ type: "noop" });
  });

  it("re-connects when the host switches to a different account", () => {
    const a = hostSyncAction(state({ selectedAccount: ACC_B }), {
      accountType: "host",
      ss58: "5GrwA",
    });
    expect(a).toEqual({ type: "connect", account: ACC_B });
  });

  it("disconnects a stale host account when the session drops (status not connected)", () => {
    const a = hostSyncAction(state({ status: "disconnected", selectedAccount: ACC_A }), {
      accountType: "host",
      ss58: "5GrwA",
    });
    expect(a).toEqual({ type: "disconnect" });
  });

  it("disconnects when connected but the selected account was removed (null)", () => {
    const a = hostSyncAction(state({ selectedAccount: null }), { accountType: "host", ss58: "5GrwA" });
    expect(a).toEqual({ type: "disconnect" });
  });

  it("does not touch an EVM/Substrate connection", () => {
    expect(
      hostSyncAction(state({ selectedAccount: ACC_A }), { accountType: "evm", ss58: null }),
    ).toEqual({ type: "noop" });
    expect(
      hostSyncAction(state({ status: "disconnected", selectedAccount: null }), {
        accountType: "substrate",
        ss58: "5GrwA",
      }),
    ).toEqual({ type: "noop" });
  });

  it("stays a no-op when disconnected and nothing was connected", () => {
    expect(
      hostSyncAction(state({ status: "disconnected", selectedAccount: null }), {
        accountType: null,
        ss58: null,
      }),
    ).toEqual({ type: "noop" });
  });
});
