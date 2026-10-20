import { describe, it, expect } from "vitest";
import { isKnownQuote, isNonZeroAddress, portfolioTokens, portfolioTotal, valueAt } from "./markets";

const KNOWN = "0x02faf33a00000000000000000000000001200000";
const ZERO = "0x0000000000000000000000000000000000000000";

describe("isKnownQuote", () => {
  it("accepts the known tUSD", () => {
    expect(isKnownQuote(KNOWN, KNOWN)).toBe(true);
  });

  it("rejects a different (same-named) tUSD", () => {
    // Regression: a market quoted in some other "tUSD" asset must not surface as a faucet dead end.
    expect(isKnownQuote("0x000007c000000000000000000000000001200000", KNOWN)).toBe(false);
  });

  it("matches the quote address case-insensitively", () => {
    expect(isKnownQuote(KNOWN.toUpperCase(), KNOWN)).toBe(true);
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

describe("portfolioTokens", () => {
  const token = (addr: string, symbol: string) => ({ addr: addr as `0x${string}`, name: symbol, symbol, decimals: 6 });
  const tusd = token("0x02faf33a00000000000000000000000001200000", "tUSD");
  const tnvda = token("0x02faf33b00000000000000000000000001200000", "tNVDA");
  const tmu = token("0x02faf48a00000000000000000000000001200000", "tMU");
  const market = (address: string, base: ReturnType<typeof token>) => ({
    address: address as `0x${string}`,
    base,
    quote: tusd,
    tickSize: 1n,
    minOrderSize: 1n,
    maxOrderSize: 1n,
  });

  it("lists the quote token, then each market's base with its market", () => {
    const a = market("0x00000000000000000000000000000000000000aa", tnvda);
    const b = market("0x00000000000000000000000000000000000000bb", tmu);
    expect(portfolioTokens(tusd, [a, b])).toEqual([{ token: tusd }, { token: tnvda, market: a }, { token: tmu, market: b }]);
  });

  it("lists a token once, linking the first market that has it", () => {
    const a = market("0x00000000000000000000000000000000000000aa", tnvda);
    const again = market("0x00000000000000000000000000000000000000cc", { ...tnvda, addr: tnvda.addr.toUpperCase().replace("0X", "0x") as `0x${string}` });
    expect(portfolioTokens(tusd, [a, again])).toEqual([{ token: tusd }, { token: tnvda, market: a }]);
  });

  it("lists only the quote token before the markets load", () => {
    expect(portfolioTokens(tusd, [])).toEqual([{ token: tusd }]);
  });
});

describe("valueAt and portfolioTotal", () => {
  it("values a balance at the last trade price", () => {
    // 2.5 base (6 decimals) at 220.5 quote per base: 551.25 quote (6 decimals).
    expect(valueAt(2_500_000n, 220_500_000_000_000_000_000n)).toBe(551_250_000n);
  });

  it("marks a balance without a trade, but counts a zero balance as 0", () => {
    expect(valueAt(2_500_000n, null)).toBe("no-trade");
    expect(valueAt(0n, null)).toBe(0n);
  });

  it("adds what is priced and says what was left out, and why", () => {
    expect(portfolioTotal([100n, 50n])).toEqual({ total: 150n, noTrade: false, unavailable: false });
    expect(portfolioTotal([100n, "no-trade", 50n])).toEqual({ total: 150n, noTrade: true, unavailable: false });
    expect(portfolioTotal([100n, "unavailable"])).toEqual({ total: 100n, noTrade: false, unavailable: true });
  });
});
