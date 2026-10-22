// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: © 2026 Parity Technologies
import { create } from "zustand";

/** Top-level view, mirrored in the URL hash (see lib/route.ts and hooks/use-hash-route.ts). */
export type View = "home" | "trade";

interface ViewState {
  view: View;
  setView: (view: View) => void;
  /** A panel to bring into view once rendered (`#/orders`); cleared by the panel. */
  focus: "orders" | null;
  setFocus: (focus: "orders" | null) => void;
}

export const useViewStore = create<ViewState>((set) => ({
  view: "home",
  setView: (view) => set({ view }),
  focus: null,
  setFocus: (focus) => set({ focus }),
}));
