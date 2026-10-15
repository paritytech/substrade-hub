import { describe, it, expect } from "vitest";
import { estimateMarketOrder } from "./market-order";
import { Side, type OrderBookLevel } from "../types/market";

const WAD = 10n ** 18n;
const level = (price: bigint, totalAmount: bigint): OrderBookLevel => ({ price, totalAmount, orderCount: 0 });

describe("estimateMarketOrder", () => {
  // Asks for a buy, best (lowest) first: 10 at 0.05, 10 at 0.06, then an extreme 100 at 1.00.
  const asks = [level(5n * WAD / 100n, 10n), level(6n * WAD / 100n, 10n), level(WAD, 100n)];

  it("walks the book best price first and sets the buy limit 1% above the worst level", () => {
    const est = estimateMarketOrder(Side.Buy, 15n * WAD, asks.map((l) => ({ ...l, totalAmount: l.totalAmount * WAD })))!;
    expect(est.fillable).toBe(15n * WAD);
    expect(est.quote).toBe(10n * WAD * 5n / 100n + 5n * WAD * 6n / 100n); // 0.5 + 0.3
    expect(est.worstPrice).toBe(6n * WAD / 100n);
    expect(est.limitPrice).toBe((6n * WAD / 100n) * 101n / 100n);
    expect(est.limitPrice).toBeLessThan(WAD); // the extreme ask stays out of reach
  });

  it("sets the sell limit 1% below the worst bid", () => {
    const bids = [level(5n * WAD / 100n, 10n), level(4n * WAD / 100n, 10n)];
    const est = estimateMarketOrder(Side.Sell, 15n, bids)!;
    expect(est.fillable).toBe(15n);
    expect(est.worstPrice).toBe(4n * WAD / 100n);
    expect(est.limitPrice).toBe((4n * WAD / 100n) * 99n / 100n);
  });

  it("reports a partial fill when the visible book is thinner than the order", () => {
    const est = estimateMarketOrder(Side.Buy, 500n, asks)!;
    expect(est.fillable).toBe(120n);
    expect(est.worstPrice).toBe(WAD);
  });

  it("returns null for an empty book", () => {
    expect(estimateMarketOrder(Side.Buy, 10n, [])).toBeNull();
  });

  it("honours a custom tolerance", () => {
    const deep = asks.map((l) => ({ ...l, totalAmount: l.totalAmount * WAD }));
    const est = estimateMarketOrder(Side.Buy, 5n * WAD, deep, 0n)!;
    expect(est.limitPrice).toBe(5n * WAD / 100n);
    expect(est.averagePrice).toBe(5n * WAD / 100n);
  });
});
