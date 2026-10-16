import { afterEach, describe, it, expect, vi } from "vitest";
import { encodeAbiParameters, encodeEventTopics, fromHex } from "viem";
import { dlobAbi } from "../abi/dlob";

vi.mock("../lib/client", () => ({ getTypedApi: vi.fn() }));
vi.mock("../lib/host/detect", () => ({ isInHost: () => false }));

import { getTypedApi } from "../lib/client";
import {
  ANCHOR_BLOCKS,
  MAX_LOG_RESULTS,
  fetchHostTrades,
  anchorBlocks,
  blockChunks,
  decodeTradesInBlock,
  estimateTimestamps,
  fetchEvmTrades,
} from "./use-trade-history";

const MARKET = "0x109088bd0e237449fde1a5b884c86f0559aae3a1";
const OTHER = "0x0000000000000000000000000000000000000abc";

/** A Revive.ContractEmitted record shaped the way polkadot-api v2 decodes it. */
function emitted(contract: string, txIndex = 3) {
  const topics = encodeEventTopics({ abi: dlobAbi, eventName: "Trade", args: { buyOrderId: 7, sellOrderId: 9 } });
  const data = encodeAbiParameters([{ type: "uint96" }, { type: "uint128" }], [221n * 10n ** 18n, 5_000_000n]);
  return {
    phase: { type: "ApplyExtrinsic", value: txIndex },
    event: { type: "Revive", value: { type: "ContractEmitted", value: { contract, topics, data: fromHex(data, "bytes") } } },
  };
}

describe("decodeTradesInBlock", () => {
  it("decodes a Trade from polkadot-api v2 shapes (hex contract/topics, Uint8Array data)", () => {
    const [trade, ...rest] = decodeTradesInBlock([emitted(MARKET)], MARKET, 42);
    expect(rest).toEqual([]);
    expect(trade).toMatchObject({
      blockNumber: 42,
      txIndex: 3,
      txHash: "42-3",
      buyOrderId: 7,
      sellOrderId: 9,
      price: 221n * 10n ** 18n,
      amount: 5_000_000n,
    });
  });

  it("ignores events from other contracts", () => {
    expect(decodeTradesInBlock([emitted(OTHER)], MARKET, 42)).toEqual([]);
  });
});

describe("estimateTimestamps", () => {
  it("keeps known timestamps and extrapolates the rest at the measured block rate", () => {
    const known = new Map([
      [1000, 10_000],
      [1100, 10_200], // 2s per block
    ]);
    const ts = estimateTimestamps([500, 1000, 1050, 1100], known);
    expect(ts.get(1000)).toBe(10_000);
    expect(ts.get(1100)).toBe(10_200);
    expect(ts.get(500)).toBe(9_000); // 500 blocks before the nearest anchor
    expect(ts.get(1050)).toBe(10_100);
  });

  it("assumes 2s blocks with a single anchor, and returns nothing with none", () => {
    expect(estimateTimestamps([90], new Map([[100, 1_000]])).get(90)).toBe(980);
    expect(estimateTimestamps([90], new Map()).size).toBe(0);
  });
});

describe("blockChunks", () => {
  it("covers the span in inclusive chunks of at most `size` blocks", () => {
    expect(blockChunks(1, 10, 4)).toEqual([
      [1, 4],
      [5, 8],
      [9, 10],
    ]);
  });

  it("returns a single chunk for a short span and none for an empty one", () => {
    expect(blockChunks(5, 7, 300_000)).toEqual([[5, 7]]);
    expect(blockChunks(8, 7, 300_000)).toEqual([]);
  });
});

describe("anchorBlocks", () => {
  it("keeps every block when there are at most `n`", () => {
    expect(anchorBlocks([1, 2, 3], 8)).toEqual([1, 2, 3]);
  });

  it("picks `n` evenly spaced blocks, including the first and the last", () => {
    const blocks = Array.from({ length: 100 }, (_, i) => i);
    const picked = anchorBlocks(blocks, 5);
    expect(picked).toEqual([0, 25, 50, 74, 99]);
  });
});

describe("fetchEvmTrades", () => {
  const hex = (n: number) => `0x${n.toString(16)}`;
  /** One Trade log per block from `first`, `count` blocks in all. */
  function tradeLogs(first: number, count: number) {
    const topics = encodeEventTopics({ abi: dlobAbi, eventName: "Trade", args: { buyOrderId: 1, sellOrderId: 2 } });
    const data = encodeAbiParameters([{ type: "uint96" }, { type: "uint128" }], [221n * 10n ** 18n, 5_000_000n]);
    return Array.from({ length: count }, (_, i) => ({
      data,
      topics,
      blockNumber: hex(first + i),
      transactionHash: `0x${(first + i).toString(16).padStart(64, "0")}`,
      transactionIndex: "0x1",
      logIndex: "0x0",
    }));
  }

  /**
   * An eth-rpc stub at block `head` serving `logs` (one per block, in block order). Like eth-rpc, a log
   * query returns at most `MAX_LOG_RESULTS` logs of its span, the oldest. Returns the methods it was
   * called with, and the span of each log query.
   */
  function stubEthRpc(head: number, logs: ReturnType<typeof tradeLogs>) {
    const calls: string[] = [];
    const spans: Array<[number, number]> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        expect(init.signal).toBeInstanceOf(AbortSignal);
        const { method, params } = JSON.parse(init.body as string) as { method: string; params: unknown[] };
        calls.push(method);
        const logsIn = ({ fromBlock, toBlock }: { fromBlock: string; toBlock: string }) => {
          const [from, to] = [parseInt(fromBlock, 16), parseInt(toBlock, 16)];
          spans.push([from, to]);
          return logs
            .filter((l) => parseInt(l.blockNumber, 16) >= from && parseInt(l.blockNumber, 16) <= to)
            .slice(0, MAX_LOG_RESULTS);
        };
        const result =
          method === "eth_blockNumber"
            ? hex(head)
            : method === "eth_getLogs"
              ? logsIn(params[0] as { fromBlock: string; toBlock: string })
              : { timestamp: hex(1_700_000_000 + 2 * parseInt(params[0] as string, 16)) };
        return { json: async () => ({ result }) };
      }),
    );
    return Object.assign(calls, { spans });
  }

  afterEach(() => vi.unstubAllGlobals());

  it("requests a bounded number of block timestamps however many blocks hold trades", async () => {
    const calls = stubEthRpc(10_000, tradeLogs(5_000, 500));
    const trades = await fetchEvmTrades("0x00000000000000000000000000000000000000b1");
    expect(trades).toHaveLength(500);
    expect(calls.filter((m) => m === "eth_getBlockByNumber").length).toBeLessThanOrEqual(ANCHOR_BLOCKS + 1);
    // Estimated timestamps follow the anchors' block rate (2 s per block in this stub).
    expect(trades[123]!.timestamp).toBe(1_700_000_000 + 2 * 5_123);
  });

  it("keeps the newest trades when a chunk holds more logs than eth-rpc returns at once", async () => {
    stubEthRpc(100_000, tradeLogs(50_000, 12_000));
    const trades = await fetchEvmTrades("0x00000000000000000000000000000000000000b3");
    expect(trades).toHaveLength(2000);
    expect(trades[0]!.blockNumber).toBe(60_000);
    expect(trades.at(-1)!.blockNumber).toBe(61_999);
  });

  it("stops at the newest chunks once they hold enough trades", async () => {
    const head = 1_300_000;
    const calls = stubEthRpc(head, [...tradeLogs(10_000, 10), ...tradeLogs(1_250_000, 2500)]);
    const trades = await fetchEvmTrades("0x00000000000000000000000000000000000000b4");
    expect(trades).toHaveLength(2000);
    expect(trades.at(-1)!.blockNumber).toBe(1_252_499);
    // Only the newest 300,000-block chunk was queried; the trades at block 10,000 were never needed.
    expect(calls.spans).toHaveLength(1);
    expect(calls.spans[0]![1]).toBe(head);
    expect(calls.spans[0]![0]).toBeGreaterThan(1_000_000);
  });

  it("fails when eth-rpc does not answer in time, so the next poll retries", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new DOMException("The operation timed out.", "TimeoutError");
      }),
    );
    await expect(fetchEvmTrades("0x00000000000000000000000000000000000000b2")).rejects.toThrow("timed out");
  });
});

describe("fetchHostTrades", () => {
  it("resumes after a long pause by scanning at most the last 200 blocks", async () => {
    let head = 1_000;
    const hashReads: number[] = [];
    vi.mocked(getTypedApi).mockReturnValue({
      query: {
        System: {
          Number: { getValue: async () => head },
          BlockHash: { getValue: async (n: number) => (hashReads.push(n), null) },
        },
      },
    } as never);
    const market = "0x00000000000000000000000000000000000000c1";
    await fetchHostTrades(market);
    hashReads.length = 0;

    head = 100_000; // about two days of 2 s blocks later
    await fetchHostTrades(market);
    expect(hashReads.length).toBeLessThanOrEqual(200);
    expect(Math.min(...hashReads)).toBe(head - 200);
  });
});
