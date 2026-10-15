import { describe, it, expect } from "vitest";
import { isKnownQuote, isNonZeroAddress } from "./markets";

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
