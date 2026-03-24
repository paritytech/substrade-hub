import { create } from "zustand";

interface WalletState {
  h160: `0x${string}` | null;
  originAccount: `0x${string}` | null;
  isConnecting: boolean;

  connect: (address: `0x${string}`) => void;
  disconnect: () => void;
  setConnecting: (v: boolean) => void;
}

function h160ToOriginAccount(h160: `0x${string}`): `0x${string}` {
  const clean = h160.replace("0x", "").toLowerCase();
  return `0x${clean}${"ee".repeat(12)}` as `0x${string}`;
}

export const useWalletStore = create<WalletState>((set) => ({
  h160: null,
  originAccount: null,
  isConnecting: false,

  connect: (address) => {
    set({
      h160: address as `0x${string}`,
      originAccount: h160ToOriginAccount(address),
      isConnecting: false,
    });
  },

  disconnect: () =>
    set({
      h160: null,
      originAccount: null,
    }),

  setConnecting: (isConnecting) => set({ isConnecting }),
}));
