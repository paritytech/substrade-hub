import { create } from "zustand";

/** Top-level view. A lightweight toggle (no router) — gateway-safe for the .dot static bundle. */
export type View = "home" | "trade";

interface ViewState {
  view: View;
  setView: (view: View) => void;
}

export const useViewStore = create<ViewState>((set) => ({
  view: "home",
  setView: (view) => set({ view }),
}));
