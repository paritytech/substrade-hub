import { useRef, useEffect } from "react";
import {
  createChart,
  type IChartApi,
  type ISeriesApi,
  ColorType,
  CandlestickSeries,
  type CandlestickData,
  type Time,
} from "lightweight-charts";
import { useCandleData } from "../../hooks/use-candle-data";
import { useBestPrices } from "../../hooks/use-best-prices";
import { useChartStore, RANGE_CANDLE_INTERVAL, type TimeRange } from "../../stores/chart";

export function PriceChart() {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const candleSeriesRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const candles = useCandleData();
  const { data: bestPrices } = useBestPrices();
  const prevCandleCountRef = useRef(0);
  const pulseRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const pulseTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const { timeRange, setTimeRange } = useChartStore();
  const candleLabel = RANGE_CANDLE_INTERVAL[timeRange] < 60
    ? `${RANGE_CANDLE_INTERVAL[timeRange]}s`
    : `${RANGE_CANDLE_INTERVAL[timeRange] / 60}m`;
  const ranges: TimeRange[] = ["1D", "1H"];

  useEffect(() => {
    if (!containerRef.current) return;

    const chart = createChart(containerRef.current, {
      layout: {
        background: { type: ColorType.Solid, color: "transparent" },
        textColor: "#9ca3af",
        fontFamily: "ui-monospace, monospace",
      },
      grid: {
        vertLines: { color: "rgba(255,255,255,0.04)" },
        horzLines: { color: "rgba(255,255,255,0.04)" },
      },
      crosshair: {
        vertLine: { labelBackgroundColor: "#374151" },
        horzLine: { labelBackgroundColor: "#374151" },
      },
      rightPriceScale: {
        borderColor: "rgba(255,255,255,0.1)",
      },
      timeScale: {
        borderColor: "rgba(255,255,255,0.1)",
        timeVisible: true,
        secondsVisible: false,
        barSpacing: 8,
        minBarSpacing: 4,
        rightOffset: 20,
      },
      handleScroll: { vertTouchDrag: false },
    });

    const candleSeries = chart.addSeries(CandlestickSeries, {
      upColor: "#22c55e",
      downColor: "#ef4444",
      borderDownColor: "#ef4444",
      borderUpColor: "#22c55e",
      wickDownColor: "#ef4444",
      wickUpColor: "#22c55e",
    });

    chartRef.current = chart;
    candleSeriesRef.current = candleSeries;

    const observer = new ResizeObserver((entries) => {
      const { width, height } = entries[0]!.contentRect;
      chart.applyOptions({ width, height });
    });
    observer.observe(containerRef.current);

    return () => {
      observer.disconnect();
      chart.remove();
      chartRef.current = null;
      candleSeriesRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (!candleSeriesRef.current) return;

    // No candles: show a flat line at the mid-spread so the y-axis isn't at 0
    if (!candles.length) {
      if (bestPrices && (bestPrices.bestBid > 0n || bestPrices.bestAsk > 0n)) {
        const bid = Number(bestPrices.bestBid) / 1e18;
        const ask = Number(bestPrices.bestAsk) / 1e18;
        const mid = bid > 0 && ask > 0 ? (bid + ask) / 2 : bid || ask;
        const now = Math.floor(Date.now() / 1000) as unknown as Time;
        candleSeriesRef.current.setData([
          { time: now, open: mid, high: mid, low: mid, close: mid, color: "#6b7280", borderColor: "#6b7280", wickColor: "#6b7280" },
        ]);
        const MIN_RANGE = 10;
        candleSeriesRef.current.applyOptions({
          autoscaleInfoProvider: () => ({
            priceRange: { minValue: mid - MIN_RANGE / 2, maxValue: mid + MIN_RANGE / 2 },
          }),
        });
      }
      return;
    }

    // Standard candle coloring: green if close >= open, red if close < open.
    // Dojis (open == close) get a tiny nudge so the body is visible as a thin line,
    // but small enough (0.05% of price) that the y-axis label stays accurate.
    const NEUTRAL = "#6b7280";
    const GREEN = "#22c55e";
    const RED = "#ef4444";
    const candleData: CandlestickData<Time>[] = candles.map((c) => {
      const { close, high } = c;
      let { open, low } = c;
      const minBody = open * 0.0005; // 0.05% of price — ~$0.09 at $175
      let color: string;

      if (close > open) {
        color = GREEN;
      } else if (close < open) {
        color = RED;
      } else {
        // Doji — nudge open down so the close (price tag) stays at the true price
        color = NEUTRAL;
        open = close - minBody;
        low = Math.min(low, open);
      }

      return {
        time: c.time as Time,
        open,
        high,
        low,
        close,
        color,
        borderColor: color,
        wickColor: color,
      };
    });

    candleSeriesRef.current.setData(candleData);

    // Compute price range: fit all candles, centered on mid-spread,
    // with a minimum of 5% of mid-spread (never less than $10).
    const bid = bestPrices ? Number(bestPrices.bestBid) / 1e18 : 0;
    const ask = bestPrices ? Number(bestPrices.bestAsk) / 1e18 : 0;
    const mid = bid > 0 && ask > 0 ? (bid + ask) / 2 : bid || ask || 175;

    const allPrices = candleData.flatMap((c) => [c.high, c.low]);
    const dataMin = Math.min(...allPrices);
    const dataMax = Math.max(...allPrices);
    const minRange = Math.max(10, mid * 0.05); // 5% of spread center, at least $10
    const padding = 0.5; // $0.50 breathing room above/below candles

    // Start with range that fits all candles
    let rangeMin = dataMin - padding;
    let rangeMax = dataMax + padding;

    // Expand to minimum range if needed, centered on mid-spread
    if (rangeMax - rangeMin < minRange) {
      rangeMin = mid - minRange / 2;
      rangeMax = mid + minRange / 2;
    }

    // Ensure all candles are still visible (expand if candles fall outside)
    if (dataMin - padding < rangeMin) rangeMin = dataMin - padding;
    if (dataMax + padding > rangeMax) rangeMax = dataMax + padding;

    candleSeriesRef.current.applyOptions({
      autoscaleInfoProvider: () => ({
        priceRange: { minValue: rangeMin, maxValue: rangeMax },
      }),
    });

    // Flash indicator when new candle data arrives
    const isNewData = prevCandleCountRef.current > 0 && candles.length > prevCandleCountRef.current;
    prevCandleCountRef.current = candles.length;
    if (isNewData && candleData.length > 0) {
      const last = candleData[candleData.length - 1]!;
      const series = candleSeriesRef.current;
      const isUp = last.close >= last.open;
      const brightColor = "#ffffff";
      const normalColor = isUp ? GREEN : RED;

      // Clear any existing pulse
      if (pulseRef.current) clearInterval(pulseRef.current);
      if (pulseTimeoutRef.current) clearTimeout(pulseTimeoutRef.current);

      // Toggle between bright and normal every 500ms
      let bright = true;
      pulseRef.current = setInterval(() => {
        const c = bright ? brightColor : normalColor;
        series.update({ ...last, color: c, borderColor: c, wickColor: c });
        bright = !bright;
      }, 500);

      // Stop pulsing after 10 seconds, restore normal color
      pulseTimeoutRef.current = setTimeout(() => {
        if (pulseRef.current) clearInterval(pulseRef.current);
        series.update(last);
      }, 10000);
    }

    // Scroll to show latest candle
    chartRef.current?.timeScale().scrollToPosition(5, false);
  }, [candles, bestPrices]);

  return (
    <div className="relative h-full w-full">
      <div className="absolute left-3 top-2 z-10 flex items-center gap-1">
        {ranges.map((r) => (
          <button
            key={r}
            onClick={() => setTimeRange(r)}
            className={`rounded px-2 py-0.5 text-xs font-medium ${
              timeRange === r
                ? "bg-brand text-white"
                : "bg-surface-overlay text-text-muted hover:text-text-primary"
            }`}
          >
            {r}
          </button>
        ))}
        <span className="ml-1 text-xs text-text-muted">{candleLabel} candles</span>
      </div>
      <div ref={containerRef} className="h-full w-full" />
      {candles.length === 0 && (
        <div className="absolute inset-0 flex items-center justify-center text-sm text-text-muted">
          No trades yet — place a market order to generate chart data
        </div>
      )}
    </div>
  );
}
