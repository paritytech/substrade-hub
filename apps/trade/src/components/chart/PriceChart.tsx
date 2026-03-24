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
import { useChartStore, RANGE_CANDLE_INTERVAL, type TimeRange } from "../../stores/chart";

export function PriceChart() {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const candleSeriesRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const candles = useCandleData();
  const { timeRange, setTimeRange } = useChartStore();
  const candleLabel = RANGE_CANDLE_INTERVAL[timeRange] < 60
    ? `${RANGE_CANDLE_INTERVAL[timeRange]}s`
    : `${RANGE_CANDLE_INTERVAL[timeRange] / 60}m`;
  const ranges: TimeRange[] = ["1H", "1D"];

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
    if (!candleSeriesRef.current || !candles.length) return;

    // Standard candle coloring: green if close >= open, red if close < open.
    // Flat candles (doji) get a minimum body height and neutral grey color.
    const MIN_BODY = 0.1;
    const NEUTRAL = "#6b7280";
    const GREEN = "#22c55e";
    const RED = "#ef4444";
    const candleData: CandlestickData<Time>[] = candles.map((c) => {
      let { open, close, high, low } = c;
      let color: string;

      if (close > open) {
        color = GREEN;
      } else if (close < open) {
        color = RED;
      } else {
        // Doji — give it a minimum body so it's visible
        color = NEUTRAL;
        close = open + MIN_BODY;
        high = Math.max(high, close);
      }

      // Ensure minimum body height for very small moves too
      if (Math.abs(close - open) < MIN_BODY && close >= open) {
        close = open + MIN_BODY;
        high = Math.max(high, close);
      } else if (Math.abs(close - open) < MIN_BODY && close < open) {
        open = close + MIN_BODY;
        high = Math.max(high, open);
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

    // Ensure minimum $10 visible price range so small candles look small
    const MIN_RANGE = 10;
    candleSeriesRef.current.applyOptions({
      autoscaleInfoProvider: () => {
        const prices = candleData.flatMap((c) => [c.high, c.low]);
        const min = Math.min(...prices);
        const max = Math.max(...prices);
        const range = max - min;
        if (range < MIN_RANGE) {
          const mid = (min + max) / 2;
          return {
            priceRange: {
              minValue: mid - MIN_RANGE / 2,
              maxValue: mid + MIN_RANGE / 2,
            },
          };
        }
        return null;
      },
    });

    // Scroll to show latest candle
    chartRef.current?.timeScale().scrollToPosition(5, false);
  }, [candles]);

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
