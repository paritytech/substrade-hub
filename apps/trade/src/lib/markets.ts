import type { MarketInfo } from "../types/market";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

/**
 * Keep only markets quoted in the tUSD we actually control (by address, case-insensitive). A
 * same-named-but-different-asset "tUSD" would be a dead end for faucet tokens, so it must not surface.
 */
export function filterKnownQuoteMarkets(
  markets: MarketInfo[],
  knownQuoteAddr: string,
): MarketInfo[] {
  const known = knownQuoteAddr.toLowerCase();
  return markets.filter((m) => m.quote.addr.toLowerCase() === known);
}

/** True when an address is set to something other than the zero address (case-insensitive). */
export function isNonZeroAddress(addr: string): boolean {
  return !!addr && addr.toLowerCase() !== ZERO_ADDRESS;
}
