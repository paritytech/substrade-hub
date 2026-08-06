import { describe, it, expect } from "vitest";
import { filterKnownQuoteMarkets, isNonZeroAddress } from "./markets";
import type { MarketInfo } from "../types/market";

const KNOWN = "0x02faf33a00000000000000000000000001200000";
const ZERO = "0x0000000000000000000000000000000000000000";

function market(quoteAddr: string, address = "0xaaaa"): MarketInfo {
  return {
    address: address as `0x${string}`,
    base: { addr: "0xbase" as `0x${string}`, name: "Test Micron", symbol: "tMU", decimals: 6 },
    quote: { addr: quoteAddr as `0x${string}`, name: "Test USD", symbol: "tUSD", decimals: 6 },
    tickSize: 0n,
    minOrderSize: 0n,
    maxOrderSize: 0n,
  };
}

describe("filterKnownQuoteMarkets", () => {
  it("keeps markets quoted in the known tUSD", () => {
    expect(filterKnownQuoteMarkets([market(KNOWN)], KNOWN)).toHaveLength(1);
  });

  it("drops a market quoted in a different (same-named) tUSD", () => {
    // Regression: a market quoted in some other "tUSD" asset must not surface as a faucet dead end.
    const wrong = "0x000007c000000000000000000000000001200000";
    const kept = filterKnownQuoteMarkets([market(KNOWN, "0xgood"), market(wrong, "0xbad")], KNOWN);
    expect(kept).toHaveLength(1);
    expect(kept[0]!.address).toBe("0xgood");
  });

  it("matches the quote address case-insensitively", () => {
    expect(filterKnownQuoteMarkets([market(KNOWN.toUpperCase())], KNOWN)).toHaveLength(1);
  });

  it("returns empty when nothing matches", () => {
    expect(filterKnownQuoteMarkets([market("0xdeadbeef")], KNOWN)).toHaveLength(0);
  });
});

describe("isNonZeroAddress", () => {
  it("is false for the zero address (any case) and empty", () => {
    expect(isNonZeroAddress(ZERO)).toBe(false);
    expect(isNonZeroAddress(ZERO.toUpperCase())).toBe(false);
    expect(isNonZeroAddress("")).toBe(false);
  });

  it("is true for a real address", () => {
    expect(isNonZeroAddress(KNOWN)).toBe(true);
  });
});
