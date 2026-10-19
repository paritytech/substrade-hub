import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";

const GENESIS = `0x${"ab".repeat(32)}`;
const OTHER = `0x${"cd".repeat(32)}`;

// Sentinels shared between the mock factories and the assertions.
const { API, HOST_PROVIDER, WS_PROVIDER, chainSpec, NotSupported } = vi.hoisted(() => {
  class NotSupported extends Error {
    constructor(readonly genesisHash: string) {
      super(`not supported: ${genesisHash}`);
    }
  }
  return {
    API: { kind: "typed" },
    HOST_PROVIDER: { kind: "host-provider" },
    WS_PROVIDER: { kind: "ws-provider" },
    chainSpec: vi.fn(),
    NotSupported,
  };
});

vi.mock("polkadot-api", () => ({
  createClient: vi.fn(() => ({ getTypedApi: () => API, getChainSpecData: chainSpec, destroy: vi.fn() })),
}));
vi.mock("polkadot-api/ws", () => ({ getWsProvider: vi.fn(() => WS_PROVIDER) }));
vi.mock("@polkadot-api/descriptors", () => ({ ah_previewnet: {}, ah_paseo_v2: {} }));
vi.mock("@parity/product-sdk-host", () => ({
  ChainNotSupportedError: NotSupported,
  getHostChainInfo: vi.fn(),
  getHostProvider: vi.fn(),
}));
vi.mock("./host/detect", () => ({ isInHost: vi.fn() }));
vi.mock("../config/chains", () => ({
  activeChain: { name: "Test AH", papiEntry: "ah_previewnet", genesis: `0x${"ab".repeat(32)}`, wsEndpoint: "wss://test" },
}));

import { initChainClient, getTypedApi, destroyClient } from "./client";
import { createClient } from "polkadot-api";
import { getHostChainInfo, getHostProvider } from "@parity/product-sdk-host";
import { isInHost } from "./host/detect";

beforeEach(() => {
  destroyClient(); // clear module singletons between tests
  vi.clearAllMocks();
  chainSpec.mockResolvedValue({ genesisHash: GENESIS });
  vi.mocked(getHostChainInfo).mockResolvedValue({ network: "paseo", chains: { AssetHub: GENESIS } } as never);
  vi.mocked(getHostProvider).mockResolvedValue(HOST_PROVIDER as never);
});
afterEach(() => {
  destroyClient();
  vi.useRealTimers();
});

describe("initChainClient", () => {
  it("standalone: builds a WS client and verifies its genesis", async () => {
    vi.mocked(isInHost).mockReturnValue(false);
    await initChainClient();
    expect(getHostProvider).not.toHaveBeenCalled();
    expect(createClient).toHaveBeenCalledWith(WS_PROVIDER);
    expect(chainSpec).toHaveBeenCalledOnce();
    expect(getTypedApi()).toBe(API);
  });

  it("standalone: rejects when the live genesis differs (chain reset)", async () => {
    vi.mocked(isInHost).mockReturnValue(false);
    chainSpec.mockResolvedValue({ genesisHash: OTHER });
    await expect(initChainClient()).rejects.toThrow(/may have been reset/);
  });

  it("host: routes through the host provider for the configured genesis", async () => {
    vi.mocked(isInHost).mockReturnValue(true);
    await initChainClient();
    expect(getHostProvider).toHaveBeenCalledWith(GENESIS);
    expect(createClient).toHaveBeenCalledWith(HOST_PROVIDER);
    expect(getTypedApi()).toBe(API);
  });

  it("host: proceeds when discovery is unavailable", async () => {
    vi.mocked(isInHost).mockReturnValue(true);
    vi.mocked(getHostChainInfo).mockResolvedValue(null);
    await initChainClient();
    expect(getHostProvider).toHaveBeenCalledWith(GENESIS);
  });

  it("host: rejects when the host serves a different Asset Hub, without opening a provider", async () => {
    vi.mocked(isInHost).mockReturnValue(true);
    vi.mocked(getHostChainInfo).mockResolvedValue({ network: "paseo", chains: { AssetHub: OTHER } } as never);
    const err = await initChainClient().catch((e: unknown) => e);
    expect((err as Error).message).toMatch(/Polkadot host is on another network/);
    expect((err as Error).message).not.toMatch(/0x/); // no genesis hashes on screen
    expect(String((err as Error).cause)).toMatch(/on "paseo"/); // kept for the console
    expect(getHostProvider).not.toHaveBeenCalled();
    expect(createClient).not.toHaveBeenCalled();
  });

  it("host: ChainNotSupportedError is definitive (no retry) and never falls back to WS", async () => {
    vi.mocked(isInHost).mockReturnValue(true);
    vi.mocked(getHostProvider).mockRejectedValue(new NotSupported(GENESIS));
    await expect(initChainClient()).rejects.toThrow(/does not serve Test AH/);
    expect(getHostProvider).toHaveBeenCalledOnce();
    expect(createClient).not.toHaveBeenCalled();
  });

  it("host: retries a transient provider failure once", async () => {
    vi.useFakeTimers();
    vi.mocked(isInHost).mockReturnValue(true);
    vi.mocked(getHostProvider).mockRejectedValueOnce(new Error("bridge not ready"));
    const init = initChainClient();
    await vi.runAllTimersAsync();
    await init;
    expect(getHostProvider).toHaveBeenCalledTimes(2);
    expect(getTypedApi()).toBe(API);
  });

  it("host: a null provider (host gone) rejects", async () => {
    vi.mocked(isInHost).mockReturnValue(true);
    vi.mocked(getHostProvider).mockResolvedValue(null);
    await expect(initChainClient()).rejects.toThrow(/not available/);
  });

  it("is idempotent and concurrency-safe (StrictMode double-mount)", async () => {
    vi.mocked(isInHost).mockReturnValue(true);
    await Promise.all([initChainClient(), initChainClient()]);
    await initChainClient();
    expect(createClient).toHaveBeenCalledOnce();
  });

  it("a failed init can be retried", async () => {
    vi.mocked(isInHost).mockReturnValue(false);
    chainSpec.mockRejectedValueOnce(new Error("socket closed"));
    await expect(initChainClient()).rejects.toThrow(/socket closed/);
    await initChainClient();
    expect(getTypedApi()).toBe(API);
  });
});

describe("getTypedApi (pre-init safety net)", () => {
  it("standalone: builds a WS client on first use if initChainClient hasn't run", () => {
    vi.mocked(isInHost).mockReturnValue(false);
    expect(getTypedApi()).toBe(API);
    expect(createClient).toHaveBeenCalledOnce();
  });

  it("host mode: throws instead of opening a direct WS when uninitialized", () => {
    vi.mocked(isInHost).mockReturnValue(true);
    expect(() => getTypedApi()).toThrow(/not initialized|unavailable/i);
    expect(createClient).not.toHaveBeenCalled();
  });
});
