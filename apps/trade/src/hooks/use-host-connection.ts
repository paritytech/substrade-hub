import { useEffect } from "react";
import { subscribeConnectionStatus } from "@parity/product-sdk-host";
import { isInHost } from "../lib/host/detect";
import { useHostConnectionStore } from "../stores/host-connection";

/**
 * Follow the host channel's connection status for the app's lifetime (see `stores/host-connection`).
 * A no-op outside a host: subscribing builds the host client, and a plain tab has none.
 */
export function useHostConnection(): void {
  useEffect(() => {
    if (!isInHost()) return;
    return subscribeConnectionStatus((status) => useHostConnectionStore.getState().report(status));
  }, []);
}
