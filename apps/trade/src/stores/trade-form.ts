import { create } from "zustand";
import { Side } from "../types/market";

type OrderType = "limit" | "market";

interface TradeFormState {
  side: Side;
  orderType: OrderType;
  price: string;
  amount: string;

  setSide: (side: Side) => void;
  setOrderType: (type: OrderType) => void;
  setPrice: (price: string) => void;
  setAmount: (amount: string) => void;
  reset: () => void;
}

export const useTradeFormStore = create<TradeFormState>((set) => ({
  side: Side.Buy,
  orderType: "limit",
  price: "",
  amount: "",

  setSide: (side) => set({ side }),
  setOrderType: (orderType) => set({ orderType }),
  setPrice: (price) => set({ price }),
  setAmount: (amount) => set({ amount }),
  reset: () => set({ price: "", amount: "" }),
}));
