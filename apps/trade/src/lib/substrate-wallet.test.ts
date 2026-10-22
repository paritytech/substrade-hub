// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: © 2026 Parity Technologies
import { describe, it, expect } from "vitest";
import type { InjectedPolkadotAccount } from "polkadot-api/pjs-signer";
import { isAccountPresent } from "./substrate-wallet";

const acc = (address: string) => ({ address }) as unknown as InjectedPolkadotAccount;

describe("isAccountPresent (account-change watcher)", () => {
  it("is true when the address is still in the list", () => {
    expect(isAccountPresent([acc("5A"), acc("5B")], "5B")).toBe(true);
  });

  it("is false when the address was removed / the extension locked", () => {
    expect(isAccountPresent([acc("5A")], "5B")).toBe(false);
  });

  it("is false for an empty account list", () => {
    expect(isAccountPresent([], "5B")).toBe(false);
  });
});
