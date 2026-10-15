import { describe, it, expect } from "vitest";
import { estimateMarketOrder } from "./market-order";
import { Side, type OrderBookLevel } from "../types/market";

const WAD = 10n ** 18n;
const level = (price: bigint, totalAmount: bigint): OrderBookLevel => ({
  price: price * WAD,
  totalAmount: totalAmount * WAD,
  orderCount: 0,
});

// Thin honest asks, then an extreme ask inside the visible levels.
const asks = [level(220n, 10n), level(221n, 10n), level(10_000n, 100n)];
// Thin honest bids, then a bid at a near-zero price.
const bids = [level(220n, 10n), level(219n, 10n), level(1n, 100n)];

describe("estimateMarketOrder", () => {
  it("prices a buy against the asks and sets the limit 1% above the worst level reached", () => {
    const est = estimateMarketOrder(Side.Buy, 15n * WAD, asks)!;
    expect(est.fillable).toBe(15n * WAD);
    expect(est.quote).toBe(10n * 220n * WAD + 5n * 221n * WAD);
    expect(est.worstPrice).toBe(221n * WAD);
    expect(est.limitPrice).toBe((221n * WAD * 101n) / 100n);
  });

  it("never reaches an extreme ask, even inside the visible levels", () => {
    const est = estimateMarketOrder(Side.Buy, 50n * WAD, asks)!;
    expect(est.fillable).toBe(20n * WAD); // the 10,000 level is beyond 10% of the best ask
    expect(est.worstPrice).toBe(221n * WAD);
    expect(est.limitPrice).toBeLessThanOrEqual((220n * WAD * 110n) / 100n);
  });

  it("caps the limit at 10% from the best price whatever the slippage", () => {
    const est = estimateMarketOrder(Side.Buy, 20n * WAD, asks, 1_000n)!; // 221 + 10% passes the cap
    expect(est.limitPrice).toBe((220n * WAD * 110n) / 100n);
  });

  it("prices a sell against the bids and sets the limit 1% below the worst level reached", () => {
    const est = estimateMarketOrder(Side.Sell, 15n * WAD, bids)!;
    expect(est.fillable).toBe(15n * WAD);
    expect(est.worstPrice).toBe(219n * WAD);
    expect(est.limitPrice).toBe((219n * WAD * 99n) / 100n);
  });

  it("never reaches a bid at an extreme low price", () => {
    const est = estimateMarketOrder(Side.Sell, 50n * WAD, bids)!;
    expect(est.fillable).toBe(20n * WAD);
    expect(est.limitPrice).toBeGreaterThanOrEqual((220n * WAD * 90n) / 100n);
  });

  it("returns null for an empty book", () => {
    expect(estimateMarketOrder(Side.Buy, WAD, [])).toBeNull();
  });

  it("reports the average price of the fill", () => {
    const est = estimateMarketOrder(Side.Buy, 20n * WAD, asks, 0n)!;
    expect(est.averagePrice).toBe((2205n * WAD) / 10n); // (220 + 221) / 2
  });
});
