// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: © 2026 Parity Technologies
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { HostConnectionStatus } from "@parity/product-sdk-host";

const { subscribeConnectionStatus } = vi.hoisted(() => ({ subscribeConnectionStatus: vi.fn() }));
vi.mock("@parity/product-sdk-host", () => ({ subscribeConnectionStatus }));

import { followHostConnection } from "./use-host-connection";
import { useHostConnectionStore } from "../stores/host-connection";

/** Subscribe with the host reporting `first` synchronously, as the SDK does. */
function follow(first: HostConnectionStatus) {
  let emit: (s: HostConnectionStatus) => void = () => {};
  subscribeConnectionStatus.mockImplementationOnce((cb: (s: HostConnectionStatus) => void) => {
    emit = cb;
    cb(first);
    return () => {};
  });
  followHostConnection();
  return (s: HostConnectionStatus) => emit(s);
}

describe("followHostConnection", () => {
  beforeEach(() => useHostConnectionStore.setState({ connection: "ok", everConnected: false }));

  it("reads a channel that dropped after boot as lost", () => {
    follow("disconnected");
    expect(useHostConnectionStore.getState().connection).toBe("lost");
  });

  it("is ok while connected, and follows later changes", () => {
    const emit = follow("connected");
    expect(useHostConnectionStore.getState().connection).toBe("ok");
    emit("connecting");
    expect(useHostConnectionStore.getState().connection).toBe("reconnecting");
  });
});
