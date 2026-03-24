/**
 * Convert H160 to origin account (bytes32): H160 ++ 0xEE * 12
 * This is the pallet-revive convention for mapping EVM addresses to substrate accounts.
 */
export function h160ToOriginAccount(h160: `0x${string}`): `0x${string}` {
  const clean = h160.replace("0x", "").toLowerCase();
  return `0x${clean}${"ee".repeat(12)}` as `0x${string}`;
}
