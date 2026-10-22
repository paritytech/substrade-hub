// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: © 2026 Parity Technologies
import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";

vi.mock("../config/chains", () => ({
  activeChain: { name: "Test AH", chainId: 420420417, rpcUrl: "https://test.example/eth-rpc" },
}));

import { assertWalletOnActiveChain, connectMetaMask, sendTransaction } from "./wallet";
import { UserFacingError } from "./user-errors";

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

describe("sendTransaction errors", () => {
  const params = {
    to: "0x0000000000000000000000000000000000000002",
    from: "0x0000000000000000000000000000000000000003",
    data: "0x",
  } as const;

  /** Our eth-rpc: the wallet check passes, and eth_estimateGas answers with `estimate`. */
  function stubRpc(estimate: { result?: string; error?: { message: string; data?: string } }) {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: { body: string }) => {
        const { method, params: p } = JSON.parse(init.body) as { method: string; params: unknown[] };
        if (method === "eth_estimateGas") return { json: async () => estimate };
        const result = method === "eth_blockNumber" ? "0x64" : method === "eth_gasPrice" ? "0x1" : { number: p[0], hash: "0xaaa" };
        return { json: async () => ({ result }) };
      }),
    );
  }

  it("reports a request the user rejected in the wallet as cancelled", async () => {
    stubRpc({ result: "0x10" });
    const request = vi.fn(async ({ method }: { method: string }) => {
      if (method === "eth_getBlockByNumber") return { hash: "0xaaa" };
      throw Object.assign(new Error("MetaMask Tx Signature: User denied transaction signature."), { code: 4001 });
    });
    vi.stubGlobal("window", { ethereum: { request } });
    await expect(sendTransaction(params)).rejects.toThrow("Signing was cancelled.");
  });

  it("decodes a revert found while estimating gas, before asking the wallet", async () => {
    stubRpc({ error: { message: "execution reverted", data: "0x7cf05fcb" } }); // PostOnlyWouldCross()
    const request = vi.fn(async () => ({ hash: "0xaaa" }));
    vi.stubGlobal("window", { ethereum: { request } });
    const err = await sendTransaction(params).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UserFacingError);
    expect((err as Error).message).toMatch(/post-only order/);
    expect(request).not.toHaveBeenCalledWith(expect.objectContaining({ method: "eth_sendTransaction" }));
  });
});

describe("connectMetaMask errors", () => {
  it("asks for MetaMask when it is missing", async () => {
    vi.stubGlobal("window", {});
    await expect(connectMetaMask()).rejects.toThrow(/MetaMask isn't installed/);
  });

  it("reports a connection the user rejected", async () => {
    const request = vi.fn(async () => {
      throw Object.assign(new Error("User rejected the request."), { code: 4001 });
    });
    vi.stubGlobal("window", { ethereum: { request } });
    const err = await connectMetaMask().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UserFacingError);
    expect((err as Error).message).toBe("The connection was rejected in MetaMask");
  });
});
