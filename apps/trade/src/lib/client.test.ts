import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";

// Sentinels shared between the mock factories and the assertions.
const { WS_API, HOST_API, RAW } = vi.hoisted(() => ({
  WS_API: { kind: "ws" },
  HOST_API: { kind: "host" },
  RAW: { kind: "raw" },
}));

vi.mock("polkadot-api", () => ({
  createClient: vi.fn(() => ({ getTypedApi: () => WS_API, destroy: vi.fn() })),
}));
vi.mock("polkadot-api/ws", () => ({ getWsProvider: vi.fn(() => "ws-provider") }));
vi.mock("@polkadot-api/descriptors", () => ({ passet_hub: { genesis: "0xtest" } }));
vi.mock("@parity/product-sdk-chain-client", () => ({ createChainClient: vi.fn() }));
vi.mock("@parity/product-sdk-host", () => ({ isChainSupported: vi.fn() }));
vi.mock("./host/detect", () => ({ isInHost: vi.fn() }));
vi.mock("../config/chains", () => ({
  activeChain: { name: "Test AH", genesis: "0xtest", wsEndpoint: "wss://test" },
}));

import { initChainClient, getTypedApi, getClient, destroyClient } from "./client";
import { createClient } from "polkadot-api";
import { createChainClient } from "@parity/product-sdk-chain-client";
import { isChainSupported } from "@parity/product-sdk-host";
import { isInHost } from "./host/detect";

beforeEach(() => {
  destroyClient(); // clear module singletons between tests
  vi.clearAllMocks();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.mocked(isChainSupported).mockResolvedValue({ ok: true, value: true } as never);
  vi.mocked(createChainClient).mockResolvedValue({
    assetHub: HOST_API,
    raw: { assetHub: RAW },
    destroy: vi.fn(),
  } as never);
});
afterEach(() => {
  destroyClient();
  vi.restoreAllMocks();
});

describe("initChainClient", () => {
  it("standalone: builds a WS client, never the host client", async () => {
    vi.mocked(isInHost).mockReturnValue(false);
    await initChainClient();
    expect(createChainClient).not.toHaveBeenCalled();
    expect(createClient).toHaveBeenCalledOnce();
    expect(getTypedApi()).toBe(WS_API);
  });

  it("host + supported: uses the host-routed client and our descriptor", async () => {
    vi.mocked(isInHost).mockReturnValue(true);
    await initChainClient();
    expect(isChainSupported).toHaveBeenCalledWith("0xtest");
    expect(createChainClient).toHaveBeenCalledOnce();
    expect(createClient).not.toHaveBeenCalled();
    expect(getTypedApi()).toBe(HOST_API);
    expect(getClient()).toBe(RAW);
  });

  it("host + chain unsupported: falls back to WS (no host client built)", async () => {
    vi.mocked(isInHost).mockReturnValue(true);
    vi.mocked(isChainSupported).mockResolvedValue({ ok: true, value: false } as never);
    await initChainClient();
    expect(createChainClient).not.toHaveBeenCalled();
    expect(createClient).toHaveBeenCalledOnce();
    expect(getTypedApi()).toBe(WS_API);
  });

  it("host + createChainClient throws: falls back to WS", async () => {
    vi.mocked(isInHost).mockReturnValue(true);
    vi.mocked(createChainClient).mockRejectedValue(new Error("no host provider"));
    await initChainClient();
    expect(createChainClient).toHaveBeenCalledOnce();
    expect(createClient).toHaveBeenCalledOnce();
    expect(getTypedApi()).toBe(WS_API);
  });

  it("is idempotent: a second call does not rebuild the client", async () => {
    vi.mocked(isInHost).mockReturnValue(true);
    await initChainClient();
    await initChainClient();
    expect(createChainClient).toHaveBeenCalledOnce();
  });
});

describe("getTypedApi (pre-init safety net)", () => {
  it("builds a WS client on first use if initChainClient hasn't run", () => {
    expect(getTypedApi()).toBe(WS_API);
    expect(createClient).toHaveBeenCalledOnce();
  });
});
