import { create } from "zustand";

export type TimeRange = "1H" | "12H" | "7D" | "30D";

export const TIME_RANGES: TimeRange[] = ["1H", "12H", "7D", "30D"];

/** Window length of each range, in seconds. Trades are filtered to it by block timestamp. */
export const RANGE_SECONDS: Record<TimeRange, number> = {
  "1H": 3_600,
  "12H": 43_200,
  "7D": 604_800,
  "30D": 2_592_000,
};

/** Candle width of each range, in seconds. */
export const RANGE_CANDLE_INTERVAL: Record<TimeRange, number> = {
  "1H": 10,
  "12H": 60,
  "7D": 900,
  "30D": 3_600,
};

/** Asset Hub produces a block about every 2 seconds. */
export const BLOCK_SECONDS = 2;

/** How far back trade history is fetched: the longest range, in blocks. */
export const HISTORY_BLOCKS = RANGE_SECONDS["30D"] / BLOCK_SECONDS;

interface ChartState {
  timeRange: TimeRange;
  /**
   * While true, the chart picks the shortest range that contains trades, so a quiet market opens on
   * its latest activity instead of an empty window. A range chosen by the user turns it off.
   */
  autoRange: boolean;
  setTimeRange: (range: TimeRange) => void;
  setAutoRange: (range: TimeRange) => void;
  resetAutoRange: () => void;
}

export const useChartStore = create<ChartState>((set) => ({
  timeRange: "1H",
  autoRange: true,
  setTimeRange: (timeRange) => set({ timeRange, autoRange: false }),
  setAutoRange: (timeRange) => set({ timeRange }),
  resetAutoRange: () => set({ autoRange: true }),
}));

/**
 * The shortest range whose window, ending now, contains at least one trade; the longest range when
 * none does.
 */
export function shortestRangeWithTrades(timestamps: number[], nowSeconds: number): TimeRange {
  for (const range of TIME_RANGES) {
    if (timestamps.some((t) => t >= nowSeconds - RANGE_SECONDS[range])) return range;
  }
  return TIME_RANGES[TIME_RANGES.length - 1]!;
}
