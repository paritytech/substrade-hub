import type { MarketInfo, TokenInfo } from "../types/market";

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

/** A token the portfolio lists, with the market to trade it in (none for the quote token). */
export interface PortfolioToken {
  token: Pick<TokenInfo, "addr" | "symbol" | "decimals">;
  market?: MarketInfo;
}

/**
 * Every token in the listed markets: the quote token first, then each market's base token in market
 * order, each once (a base in two markets links the first).
 */
export function portfolioTokens(
  quote: Pick<TokenInfo, "addr" | "symbol" | "decimals">,
  markets: readonly MarketInfo[],
): PortfolioToken[] {
  const seen = new Set([quote.addr.toLowerCase()]);
  const tokens: PortfolioToken[] = [{ token: quote }];
  for (const market of markets) {
    const key = market.base.addr.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    tokens.push({ token: market.base, market });
  }
  return tokens;
}

/**
 * `balance` of a base token in quote raw units at `lastPrice` (quote raw per base raw, 1e18-scaled), or
 * null when the market has no trade to price it.
 */
export function valueAt(balance: bigint, lastPrice: bigint | null): bigint | null {
  return lastPrice === null ? null : (balance * lastPrice) / 10n ** 18n;
}

/** The sum of the known `values`; `partial` when some could not be priced and are left out. */
export function portfolioTotal(values: readonly (bigint | null)[]): { total: bigint; partial: boolean } {
  let total = 0n;
  let partial = false;
  for (const v of values) {
    if (v === null) partial = true;
    else total += v;
  }
  return { total, partial };
}
