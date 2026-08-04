import { describe, it, expect } from "vitest";
import { marketApproveAmount, feeWarningThreshold, hasMarketLiquidity } from "./format";
import { Side } from "../types/market";

describe("feeWarningThreshold (chain-derived, not hardcoded)", () => {
  it("is ~0.05 token in planck for 10-decimal chains (Polkadot/Paseo)", () => {
    expect(feeWarningThreshold(10)).toBe(500_000_000n);
  });

  it("scales with the chain's decimals (12-decimal Westend)", () => {
    expect(feeWarningThreshold(12)).toBe(50_000_000_000n);
  });
});

describe("marketApproveAmount (exact-escrow guard)", () => {
  it("a sell approves exactly the base amount, ignoring the balance", () => {
    expect(marketApproveAmount(Side.Sell, 100n, 999_999n)).toBe(100n);
  });

  it("a buy approves the available quote balance (quote is fill-dependent)", () => {
    expect(marketApproveAmount(Side.Buy, 100n, 5_000n)).toBe(5_000n);
  });

  it("never returns the whole balance for a sell (regression: no full-balance approval)", () => {
    const balance = 1_000_000n;
    expect(marketApproveAmount(Side.Sell, 42n, balance)).not.toBe(balance);
  });
});

describe("hasMarketLiquidity (market-order fill guard)", () => {
  it("a buy needs asks: false when the ask side is empty", () => {
    expect(hasMarketLiquidity(Side.Buy, 100n, 0n)).toBe(false);
  });

  it("a buy can fill when there is an ask, regardless of bids", () => {
    expect(hasMarketLiquidity(Side.Buy, 0n, 50n)).toBe(true);
  });

  it("a sell needs bids: false when the bid side is empty", () => {
    expect(hasMarketLiquidity(Side.Sell, 0n, 100n)).toBe(false);
  });

  it("a sell can fill when there is a bid, regardless of asks", () => {
    expect(hasMarketLiquidity(Side.Sell, 50n, 0n)).toBe(true);
  });
});
