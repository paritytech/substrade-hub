import { describe, it, expect } from "vitest";
import { marketApproveAmount, feeWarningThreshold, hasMarketLiquidity, groupThousands } from "./format";
import { Side } from "../types/market";

describe("feeWarningThreshold (chain-derived, not hardcoded)", () => {
  it("is ~0.05 token in planck for 10-decimal chains (Polkadot/Paseo)", () => {
    expect(feeWarningThreshold(10)).toBe(500_000_000n);
  });

  it("scales with the chain's decimals (12-decimal Westend)", () => {
    expect(feeWarningThreshold(12)).toBe(50_000_000_000n);
  });
});

describe("marketApproveAmount (bounded by the order)", () => {
  const WAD = 10n ** 18n;

  it("a sell approves exactly the base amount", () => {
    expect(marketApproveAmount(Side.Sell, 100n, 5n * WAD)).toBe(100n);
  });

  it("a buy approves amount x limit price, rounded up", () => {
    expect(marketApproveAmount(Side.Buy, 100n * WAD, 5n * WAD / 100n)).toBe(5n * WAD);
    expect(marketApproveAmount(Side.Buy, 3n, WAD / 2n)).toBe(2n); // 1.5 rounds up
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

describe("groupThousands (apostrophe separators)", () => {
  it("groups the integer part and preserves the fraction", () => {
    expect(groupThousands("10000.00")).toBe("10'000.00");
    expect(groupThousands("10981.00")).toBe("10'981.00");
    expect(groupThousands("1000000")).toBe("1'000'000");
  });

  it("leaves short numbers unchanged", () => {
    expect(groupThousands("865.00")).toBe("865.00");
    expect(groupThousands("0.00")).toBe("0.00");
  });
});
