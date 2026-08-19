import { create } from "zustand";

export type TimeRange = "1H" | "12H";

interface ChartState {
  timeRange: TimeRange;
  setTimeRange: (range: TimeRange) => void;
}

// Asset Hub blocks are ~2s, so windows are block-count = seconds / 2.
export const RANGE_BLOCKS: Record<TimeRange, number> = {
  "1H": 1800, // 3600s / 2s
  "12H": 21600, // 43200s / 2s (well within the RPC's eth_getLogs range)
};

export const RANGE_CANDLE_INTERVAL: Record<TimeRange, number> = {
  "1H": 10, // 10s candles for 1H
  "12H": 60, // 1min candles for 12H
};

export const useChartStore = create<ChartState>((set) => ({
  timeRange: "1H",
  setTimeRange: (timeRange) => set({ timeRange }),
}));
