import { useMemo } from "react";
import { useTradeHistory } from "./use-trade-history";
import { useMarketStore } from "../stores/market";
import { useChartStore, RANGE_CANDLE_INTERVAL } from "../stores/chart";
import type { CandleData } from "../types/trade";

/**
 * Derive OHLCV candle data from trade events.
 * Pads empty intervals around the data so the chart doesn't stretch a single candle.
 */
export function useCandleData(): CandleData[] {
  const { data: trades } = useTradeHistory();
  const market = useMarketStore((s) => s.selectedMarket);
  const baseDecimals = market?.base.decimals ?? 6;
  const timeRange = useChartStore((s) => s.timeRange);
  const candleInterval = RANGE_CANDLE_INTERVAL[timeRange];

  return useMemo(() => {
    if (!trades?.length) return [];

    const candles = new Map<number, CandleData>();
    const baseDivisor = 10 ** baseDecimals;

    for (const trade of trades) {
      const bucket =
        Math.floor(trade.timestamp / candleInterval) * candleInterval;
      const price = Number(trade.price) / 1e18;
      const volume = Number(trade.amount) / baseDivisor;

      const existing = candles.get(bucket);
      if (existing) {
        existing.high = Math.max(existing.high, price);
        existing.low = Math.min(existing.low, price);
        existing.close = price;
        existing.volume += volume;
      } else {
        candles.set(bucket, {
          time: bucket,
          open: price,
          high: price,
          low: price,
          close: price,
          volume,
        });
      }
    }

    return Array.from(candles.values()).sort((a, b) => a.time - b.time);
  }, [trades, baseDecimals, candleInterval]);
}
