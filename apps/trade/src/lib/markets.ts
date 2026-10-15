const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

/**
 * True when a market's quote token is the tUSD we actually control (by address, case-insensitive). A
 * same-named-but-different-asset "tUSD" would be a dead end for faucet tokens, so it must not surface.
 */
export function isKnownQuote(quoteAddr: string, knownQuoteAddr: string): boolean {
  return quoteAddr.toLowerCase() === knownQuoteAddr.toLowerCase();
}

/** True when an address is set to something other than the zero address (case-insensitive). */
export function isNonZeroAddress(addr: string): boolean {
  return !!addr && addr.toLowerCase() !== ZERO_ADDRESS;
}
