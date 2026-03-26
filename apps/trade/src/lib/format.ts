import { WAD } from "../config/constants";

/**
 * Align price to the nearest tick multiple (rounds down).
 */
export function alignToTick(price: bigint, tickSize: bigint): bigint {
  return (price / tickSize) * tickSize;
}

/**
 * Derive display decimals from tick size.
 * Tick size is in 18-decimal fixed-point, so 1e16 → 2 decimals, 1e15 → 3, etc.
 */
export function tickToDisplayDecimals(tickSize: bigint): number {
  if (tickSize <= 0n) return 0;
  let d = 0;
  let t = WAD;
  while (t > tickSize && d < 18) {
    t /= 10n;
    d++;
  }
  return d;
}

/**
 * Calculate quote amount: ceil(amount * price / 1e18)
 * Mirrors PriceMath.quoteAmountCeil in the contract.
 */
export function quoteAmountCeil(amount: bigint, price: bigint): bigint {
  const product = amount * price;
  return (product + WAD - 1n) / WAD;
}

/**
 * Format a bigint token amount with decimals for display.
 */
export function formatTokenAmount(
  value: bigint,
  decimals: number = 18,
  displayDecimals: number = 0,
): string {
  const divisor = 10n ** BigInt(decimals);
  const whole = value / divisor;

  if (displayDecimals === 0) return whole.toString();

  const frac = value % divisor;
  const fracStr = frac.toString().padStart(decimals, "0").slice(0, displayDecimals);
  return `${whole}.${fracStr}`;
}

/**
 * Extract pallet-assets asset ID from an ERC20 precompile address.
 * Address format: 0x{assetId_be_4bytes}00000000000000000000000001200000
 * Returns null if the address doesn't match the trust-backed asset pattern.
 */
export function erc20ToAssetId(addr: `0x${string}`): number | null {
  const clean = addr.toLowerCase().replace("0x", "");
  if (clean.length !== 40) return null;
  if (!clean.endsWith("00000000000000000000000001200000")) return null;
  const id = parseInt(clean.slice(0, 8), 16);
  return isNaN(id) ? null : id;
}

/**
 * Parse a decimal string into a bigint with the given number of decimals.
 */
export function parseTokenAmount(value: string, decimals: number = 18): bigint {
  const [whole = "0", frac = ""] = value.split(".");
  const paddedFrac = frac.padEnd(decimals, "0").slice(0, decimals);
  return BigInt(whole) * 10n ** BigInt(decimals) + BigInt(paddedFrac);
}
