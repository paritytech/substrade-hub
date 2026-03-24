import { create } from "zustand";
import type { MarketInfo } from "../types/market";

interface MarketState {
  selectedMarket: MarketInfo | null;
  selectMarket: (market: MarketInfo) => void;
}

export const useMarketStore = create<MarketState>((set) => ({
  selectedMarket: null,
  selectMarket: (market) => set({ selectedMarket: market }),
}));
