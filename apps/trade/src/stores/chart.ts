import { create } from "zustand";

export type TimeRange = "1H" | "1D";

interface ChartState {
  timeRange: TimeRange;
  setTimeRange: (range: TimeRange) => void;
}

export const RANGE_BLOCKS: Record<TimeRange, number> = {
  "1H": 600, // ~1 hour at 6s blocks
  "1D": 14400, // ~24 hours at 6s blocks
};

export const RANGE_CANDLE_INTERVAL: Record<TimeRange, number> = {
  "1H": 10, // 10s candles for 1H
  "1D": 60, // 1min candles for 1D
};

export const useChartStore = create<ChartState>((set) => ({
  timeRange: "1H",
  setTimeRange: (timeRange) => set({ timeRange }),
}));
