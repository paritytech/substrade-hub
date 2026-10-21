import { create } from "zustand";
import { Side } from "../types/market";

type OrderType = "limit" | "market";

interface TradeFormState {
  side: Side;
  orderType: OrderType;
  price: string;
  amount: string;
  /** Market orders: fill the whole amount in one transaction, or nothing. */
  allOrNothing: boolean;
  /** Limit orders: rest only, never trade on arrival. */
  postOnly: boolean;

  setSide: (side: Side) => void;
  setOrderType: (type: OrderType) => void;
  setPrice: (price: string) => void;
  setAmount: (amount: string) => void;
  setAllOrNothing: (allOrNothing: boolean) => void;
  setPostOnly: (postOnly: boolean) => void;
  reset: () => void;
}

export const useTradeFormStore = create<TradeFormState>((set) => ({
  side: Side.Buy,
  orderType: "limit",
  price: "",
  amount: "",
  allOrNothing: false,
  postOnly: false,

  setSide: (side) => set({ side }),
  setOrderType: (orderType) => set({ orderType }),
  setPrice: (price) => set({ price }),
  setAmount: (amount) => set({ amount }),
  setAllOrNothing: (allOrNothing) => set({ allOrNothing }),
  setPostOnly: (postOnly) => set({ postOnly }),
  reset: () => set({ price: "", amount: "" }),
}));
