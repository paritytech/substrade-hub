import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";

vi.mock("../config/chains", () => ({
  activeChain: { name: "Test AH", chainId: 420420417, rpcUrl: "https://test.example/eth-rpc" },
}));

import { assertWalletOnActiveChain } from "./wallet";

/** Answer our eth-rpc (fetch) with head 0x64 and the given hash for the probed block. */
function stubOurRpc(hash: string) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init: { body: string }) => {
      const { method, params } = JSON.parse(init.body) as { method: string; params: unknown[] };
      const result = method === "eth_blockNumber" ? "0x64" : { number: params[0], hash };
      return { json: async () => ({ result }) };
    }),
  );
}

function stubWallet(block: { hash: string } | null) {
  const request = vi.fn(async () => block);
  vi.stubGlobal("window", { ethereum: { request } });
  return request;
}

beforeEach(() => stubOurRpc("0xaaa"));
afterEach(() => vi.unstubAllGlobals());

describe("assertWalletOnActiveChain", () => {
  it("passes when the wallet's RPC has the same recent block", async () => {
    const request = stubWallet({ hash: "0xaaa" });
    await expect(assertWalletOnActiveChain()).resolves.toBeUndefined();
    // Probes 5 blocks behind our head (0x64 - 5 = 0x5f).
    expect(request).toHaveBeenCalledWith({ method: "eth_getBlockByNumber", params: ["0x5f", false] });
  });

  it("rejects when the wallet's RPC is another chain with the same chain id", async () => {
    stubWallet({ hash: "0xbbb" });
    await expect(assertWalletOnActiveChain()).rejects.toThrow(/is not Test AH.*https:\/\/test\.example\/eth-rpc/);
  });

  it("rejects when the wallet's RPC does not have that block", async () => {
    stubWallet(null);
    await expect(assertWalletOnActiveChain()).rejects.toThrow(/is not Test AH/);
  });
});
