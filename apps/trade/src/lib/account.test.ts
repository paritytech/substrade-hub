// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: © 2026 Parity Technologies
import { describe, it, expect } from "vitest";
import { fromHex } from "polkadot-api/utils";
import { h160ToOriginAccount, ss58ToOriginAccount, pubkeyToH160 } from "./account";

// Well-known dev account "Alice". The public key and derived revive H160 are fixed vectors
// (computed independently), so these assertions are not circular against the implementation.
const ALICE_SS58 = "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY";
const ALICE_PUBKEY = "0xd43593c715fdd31c61141abd04a99fd6822c8558854ccde39a5684e7a56da27d";
const ALICE_H160 = "0x9621dde636de098b43efb0fa9b61facfe328f99d"; // keccak_256(pubkey)[12..32]

describe("h160ToOriginAccount (EVM account -> AccountId32)", () => {
  it("appends 0xEE * 12 to the H160", () => {
    const h160 = "0x1234567890abcdef1234567890abcdef12345678" as const;
    expect(h160ToOriginAccount(h160)).toBe(`${h160}${"ee".repeat(12)}`);
  });

  it("produces a 32-byte (0x + 64 hex) value", () => {
    const out = h160ToOriginAccount("0x1234567890abcdef1234567890abcdef12345678");
    expect(out).toHaveLength(2 + 64);
  });

  it("lower-cases the input", () => {
    expect(h160ToOriginAccount("0xABCDEF1234567890ABCDEF1234567890ABCDEF12")).toBe(
      `0xabcdef1234567890abcdef1234567890abcdef12${"ee".repeat(12)}`,
    );
  });
});

describe("ss58ToOriginAccount (Substrate account -> AccountId32)", () => {
  it("decodes an SS58 address to its raw 32-byte public key", () => {
    expect(ss58ToOriginAccount(ALICE_SS58)).toBe(ALICE_PUBKEY);
  });
});

describe("pubkeyToH160 (native account -> revive H160 fallback)", () => {
  it("returns keccak_256(pubkey)[12..32] for Alice", () => {
    expect(pubkeyToH160(fromHex(ALICE_PUBKEY))).toBe(ALICE_H160);
  });

  it("returns a 20-byte lowercase hex string", () => {
    expect(pubkeyToH160(fromHex(ALICE_PUBKEY))).toMatch(/^0x[0-9a-f]{40}$/);
  });
});
