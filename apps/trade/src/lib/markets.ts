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

/** A token's value in quote raw units, or why it has none: no trade to price it, or no price loaded. */
export type TokenValue = bigint | "no-trade" | "unavailable";

/**
 * `balance` of a base token in quote raw units at `lastPrice` (quote raw per base raw, 1e18-scaled).
 * Without a trade it is "no-trade", except a zero balance, which is worth 0 whatever the price.
 */
export function valueAt(balance: bigint, lastPrice: bigint | null): TokenValue {
  if (balance === 0n) return 0n;
  return lastPrice === null ? "no-trade" : (balance * lastPrice) / 10n ** 18n;
}

/**
 * A holding's value from its balance read and, for a base token, its price read. The balance decides
 * first: undefined while loading, "unavailable" when it failed, and a zero balance or the quote token
 * needs no price. Then the price: "unavailable" when it failed, undefined while loading.
 */
export function holdingValue(
  balance: bigint | "unavailable" | undefined,
  needsPrice: boolean,
  price: { failed: boolean; lastPrice: bigint | null | undefined },
): TokenValue | undefined {
  if (balance === undefined || balance === "unavailable") return balance;
  if (!needsPrice || balance === 0n) return balance;
  if (price.failed) return "unavailable";
  if (price.lastPrice === undefined) return undefined;
  return valueAt(balance, price.lastPrice);
}

/**
 * The sum of the priced `values`, and whether any was left out for having no trade, or for a price
 * that could not be loaded.
 */
export function portfolioTotal(values: readonly TokenValue[]): { total: bigint; noTrade: boolean; unavailable: boolean } {
  let total = 0n;
  let noTrade = false;
  let unavailable = false;
  for (const v of values) {
    if (v === "no-trade") noTrade = true;
    else if (v === "unavailable") unavailable = true;
    else total += v;
  }
  return { total, noTrade, unavailable };
}
