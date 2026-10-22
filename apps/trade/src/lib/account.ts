// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: © 2026 Parity Technologies
import { AccountId, type SS58String } from "polkadot-api";
import { toHex } from "polkadot-api/utils";
import { keccak256 } from "viem";
import { getTypedApi } from "./client";

/**
 * Convert H160 to origin account (bytes32): H160 ++ 0xEE * 12
 * This is the pallet-revive convention for mapping EVM addresses to substrate accounts.
 */
export function h160ToOriginAccount(h160: `0x${string}`): `0x${string}` {
  const clean = h160.replace("0x", "").toLowerCase();
  return `0x${clean}${"ee".repeat(12)}` as `0x${string}`;
}

const ss58Codec = AccountId();

/**
 * SS58 address -> 32-byte AccountId32, used as `originAccount` for Substrate users
 * (self-trade prevention). This is the raw public key, not the 0xEE-mapped form.
 */
export function ss58ToOriginAccount(address: string): `0x${string}` {
  return toHex(ss58Codec.enc(address as SS58String)) as `0x${string}`;
}

/**
 * Mapped revive H160 (msg.sender / the `owner` used for allowance & balance reads) for a Substrate
 * account. Preferred over deriving locally: the runtime's ReviveApi.address handles native, ecdsa and
 * EVM accounts uniformly. Async because it is a runtime call.
 */
export async function accountToH160(address: string): Promise<`0x${string}`> {
  const api = getTypedApi();
  return (await api.apis.ReviveApi.address(address as SS58String)) as `0x${string}`;
}

/**
 * Offline fallback for native sr25519 accounts only: revive H160 = keccak_256(pubkey)[12..32].
 * Prefer `accountToH160` where a runtime call is acceptable.
 */
export function pubkeyToH160(pubkey: Uint8Array): `0x${string}` {
  return `0x${keccak256(pubkey).slice(-40)}` as `0x${string}`; // last 20 bytes
}
