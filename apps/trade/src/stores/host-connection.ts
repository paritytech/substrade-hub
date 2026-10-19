import { create } from "zustand";
import type { HostConnectionStatus } from "@parity/product-sdk-host";

/**
 * The host channel's state as the UI shows it. `ok` before the first connection too: until then the
 * boot screen speaks for the connection. After it, `reconnecting` while the channel is being set up
 * again and `lost` once it is closed.
 */
export type HostConnection = "ok" | "reconnecting" | "lost";

interface HostConnectionState {
  connection: HostConnection;
  everConnected: boolean;
  /** Apply a status from `subscribeConnectionStatus`. */
  report: (status: HostConnectionStatus) => void;
}

/** The UI state after `status`, given whether the channel was ever connected. */
export function connectionFor(status: HostConnectionStatus, everConnected: boolean): HostConnection {
  if (status === "connected" || !everConnected) return "ok";
  return status === "connecting" ? "reconnecting" : "lost";
}

export const useHostConnectionStore = create<HostConnectionState>((set, get) => ({
  connection: "ok",
  everConnected: false,
  report: (status) => {
    const everConnected = get().everConnected || status === "connected";
    set({ everConnected, connection: connectionFor(status, everConnected) });
  },
}));
