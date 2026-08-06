import { WAD } from "../config/constants";
import { Side } from "../types/market";

/**
 * Approve amount for a MARKET order. A sell escrows exactly `amount` base tokens, so approve exactly
 * that; a buy pays a fill-dependent amount of quote (no limit price), so approve the available quote
 * balance until a slippage-bounded estimate is wired in. Prevents the previous full-balance approval
 * for sells.
 */
export function marketApproveAmount(side: Side, amount: bigint, quoteBalance: bigint): bigint {
  return side === Side.Sell ? amount : quoteBalance;
}

/**
 * Whether a MARKET order can fill against the book. A market order matches the opposite side (a buy
 * takes asks, a sell takes bids); if that side is empty the contract fills nothing (no revert) yet
 * still costs gas, so callers should block the order. `bestBid`/`bestAsk` are 0n when that side is
 * empty (see `getBestPrices`).
 */
export function hasMarketLiquidity(side: Side, bestBid: bigint, bestAsk: bigint): boolean {
  return side === Side.Buy ? bestAsk > 0n : bestBid > 0n;
}

/**
 * Native-balance threshold (in planck) below which to warn about insufficient fee funds — ~0.05 of the
 * native token. Derived from the chain's `tokenDecimals` (read from the chain spec) so it is correct
 * on any chain (Polkadot/Paseo = 10, Westend = 12), never hardcoded.
 */
export function feeWarningThreshold(decimals: number): bigint {
  return BigInt(Math.round(0.05 * 10 ** decimals));
}

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

/** Insert apostrophe thousands separators into a formatted number string ("10981.00" -> "10'981.00"). */
export function groupThousands(value: string): string {
  const neg = value.startsWith("-");
  const s = neg ? value.slice(1) : value;
  const dot = s.indexOf(".");
  const intPart = dot === -1 ? s : s.slice(0, dot);
  const rest = dot === -1 ? "" : s.slice(dot);
  const grouped = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, "'");
  return (neg ? "-" : "") + grouped + rest;
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
