import { create } from "zustand";
import type { PolkadotSigner } from "polkadot-api";
import { h160ToOriginAccount } from "../lib/account";
import { stopWatchingAccounts } from "../lib/substrate-wallet";
import { saveWalletHint, clearWalletHint } from "../lib/wallet-hint";

export type AccountType = "evm" | "substrate";

interface WalletState {
  // Flat fields kept for existing consumers (usePlaceOrder, use-token-*, WalletButton) which read
  // `h160` / `originAccount` directly and must not change.
  h160: `0x${string}` | null;
  originAccount: `0x${string}` | null;
  // Connection metadata + the Substrate signing capability.
  accountType: AccountType | null;
  ss58: string | null;
  signer: PolkadotSigner | null;
  mapped: boolean;
  isConnecting: boolean;

  connectEvm: (address: `0x${string}`) => void;
  connectSubstrate: (a: {
    extensionName: string;
    ss58: string;
    h160: `0x${string}`;
    originAccount: `0x${string}`;
    signer: PolkadotSigner;
  }) => void;
  setMapped: () => void;
  disconnect: () => void;
  setConnecting: (v: boolean) => void;
}

// SECURITY: do NOT wrap this store in zustand `persist`. It holds a PolkadotSigner (a signing
// capability). If persistence is ever added, persist only `{ accountType, ss58, h160 }` and re-request
// the signer on load — never serialize `signer`.
export const useWalletStore = create<WalletState>((set) => ({
  h160: null,
  originAccount: null,
  accountType: null,
  ss58: null,
  signer: null,
  mapped: false,
  isConnecting: false,

  connectEvm: (address) => {
    clearWalletHint(); // EVM connection supersedes any Substrate reconnect hint
    set({
      accountType: "evm",
      h160: address,
      originAccount: h160ToOriginAccount(address),
      ss58: null,
      signer: null,
      mapped: true, // 0xEE-suffixed accounts use the stateless fallback map — nothing to map
      isConnecting: false,
    });
  },

  connectSubstrate: (a) => {
    // Persist a non-signer hint so the connection can be re-established on reload.
    saveWalletHint({
      extensionName: a.extensionName,
      ss58: a.ss58,
      h160: a.h160,
      originAccount: a.originAccount,
    });
    set({
      accountType: "substrate",
      h160: a.h160,
      originAccount: a.originAccount,
      ss58: a.ss58,
      signer: a.signer,
      mapped: false, // confirmed by ensureMapped (a near no-op on Asset Hub's AutoMap)
      isConnecting: false,
    });
  },

  setMapped: () => set({ mapped: true }),

  disconnect: () => {
    stopWatchingAccounts();
    clearWalletHint();
    set({
      h160: null,
      originAccount: null,
      accountType: null,
      ss58: null,
      signer: null,
      mapped: false,
    });
  },

  setConnecting: (isConnecting) => set({ isConnecting }),
}));
