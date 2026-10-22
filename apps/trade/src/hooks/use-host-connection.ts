// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: © 2026 Parity Technologies
import { useEffect } from "react";
import { subscribeConnectionStatus } from "@parity/product-sdk-host";
import { isInHost } from "../lib/host/detect";
import { useHostConnectionStore } from "../stores/host-connection";

/**
 * Feed `subscribeConnectionStatus` into `stores/host-connection`; returns the unsubscribe. In a host the
 * app mounts only after `ChainBoot` reached the chain through the host channel, so the channel has been
 * connected: a first status of `disconnected` means it dropped in between.
 */
export function followHostConnection(): () => void {
  useHostConnectionStore.setState({ everConnected: true });
  return subscribeConnectionStatus((status) => useHostConnectionStore.getState().report(status));
}

/**
 * Follow the host channel's connection status for the app's lifetime (see `stores/host-connection`).
 * A no-op outside a host: subscribing builds the host client, and a plain tab has none.
 */
export function useHostConnection(): void {
  useEffect(() => (isInHost() ? followHostConnection() : undefined), []);
}
