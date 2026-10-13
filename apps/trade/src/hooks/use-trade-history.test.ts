import { describe, it, expect, vi } from "vitest";
import { encodeAbiParameters, encodeEventTopics, fromHex } from "viem";
import { dlobAbi } from "../abi/dlob";

vi.mock("../lib/client", () => ({ getTypedApi: vi.fn() }));

import { blockChunks, decodeTradesInBlock, estimateTimestamps } from "./use-trade-history";

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
