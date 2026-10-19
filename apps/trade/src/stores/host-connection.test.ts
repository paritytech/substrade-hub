import { beforeEach, describe, expect, it } from "vitest";
import { connectionFor, useHostConnectionStore } from "./host-connection";

describe("connectionFor", () => {
  it("is ok while connected, and before the first connection", () => {
    expect(connectionFor("connected", true)).toBe("ok");
    expect(connectionFor("connecting", false)).toBe("ok");
    expect(connectionFor("disconnected", false)).toBe("ok");
  });

  it("tells reconnecting from lost once the channel was up", () => {
    expect(connectionFor("connecting", true)).toBe("reconnecting");
    expect(connectionFor("disconnected", true)).toBe("lost");
  });
});

describe("useHostConnectionStore", () => {
  beforeEach(() => useHostConnectionStore.setState({ connection: "ok", everConnected: false }));
  const report = (s: Parameters<ReturnType<typeof useHostConnectionStore.getState>["report"]>[0]) =>
    useHostConnectionStore.getState().report(s);

  it("follows a drop and a recovery after the first connection", () => {
    report("connecting");
    expect(useHostConnectionStore.getState().connection).toBe("ok");
    report("connected");
    report("disconnected");
    expect(useHostConnectionStore.getState().connection).toBe("lost");
    report("connecting");
    expect(useHostConnectionStore.getState().connection).toBe("reconnecting");
    report("connected");
    expect(useHostConnectionStore.getState().connection).toBe("ok");
  });
});
