// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: © 2026 Parity Technologies
import { describe, expect, it, vi } from "vitest";
import { encodeAbiParameters, encodeEventTopics } from "viem";
import { dlobAbi } from "../abi/dlob";

const { simulateContractData } = vi.hoisted(() => ({ simulateContractData: vi.fn() }));
vi.mock("../lib/contract", () => ({ simulateContractData }));

import { limitOrderReturned, liquidityWithin, notAllOrNothing, placedBy, withinLimit } from "./use-place-order";
import { MAX_OB_LEVELS } from "../config/constants";
import { Side } from "../types/market";

const MARKET = "0x00000000000000000000000000000000000000aa";
const FROM = "0x00000000000000000000000000000000000000bb";
const ZERO = `0x${"00".repeat(32)}` as const;
const ARGS = [0, 10n ** 18n, 10n ** 6n, ZERO, ZERO, 0, 0n, false] as const;

describe("limitOrderReturned", () => {
  it("reads what the match budget returns", async () => {
    simulateContractData.mockResolvedValueOnce(encodeAbiParameters([{ type: "uint32" }, { type: "uint128" }], [7, 4n]));
    expect(await limitOrderReturned(ARGS, MARKET, FROM)).toBe(4n);
  });

  it("is 0 when the whole order fills or rests", async () => {
    simulateContractData.mockResolvedValueOnce(encodeAbiParameters([{ type: "uint32" }, { type: "uint128" }], [7, 0n]));
    expect(await limitOrderReturned(ARGS, MARKET, FROM)).toBe(0n);
  });

  it("is 0 on a market that returns only the order id", async () => {
    simulateContractData.mockResolvedValueOnce(encodeAbiParameters([{ type: "uint32" }], [7]));
    expect(await limitOrderReturned(ARGS, MARKET, FROM)).toBe(0n);
  });

  it("passes a failed simulation on", async () => {
    simulateContractData.mockRejectedValueOnce(new Error("reverted"));
    await expect(limitOrderReturned(ARGS, MARKET, FROM)).rejects.toThrow("reverted");
  });
});

describe("withinLimit", () => {
  it("takes asks up to a buy's limit", () => {
    expect(withinLimit(Side.Buy, 100n, 100n)).toBe(true);
    expect(withinLimit(Side.Buy, 101n, 100n)).toBe(false);
  });

  it("takes bids down to a sell's limit", () => {
    expect(withinLimit(Side.Sell, 100n, 100n)).toBe(true);
    expect(withinLimit(Side.Sell, 99n, 100n)).toBe(false);
  });

  it("is false for an empty book", () => {
    expect(withinLimit(Side.Buy, undefined, 100n)).toBe(false);
  });
});

describe("liquidityWithin", () => {
  const level = (price: bigint, totalAmount: bigint) => ({ price, totalAmount, orderCount: 0 });

  it("adds up the levels a market order's limit reaches", () => {
    const asks = [level(100n, 5n), level(101n, 7n), level(103n, 9n)];
    expect(liquidityWithin(Side.Buy, asks, 101n)).toBe(12n);
    const bids = [level(100n, 5n), level(99n, 7n), level(97n, 9n)];
    expect(liquidityWithin(Side.Sell, bids, 99n)).toBe(12n);
    expect(liquidityWithin(Side.Buy, [], 101n)).toBe(0n);
  });
});

describe("notAllOrNothing", () => {
  const level = (price: bigint, totalAmount: bigint) => ({ price, totalAmount, orderCount: 0 });
  const base = (amount: bigint) => `${amount} tMU`;

  it("says the side is empty when nothing is listed within the limit", () => {
    expect(notAllOrNothing(Side.Buy, 10n, [level(105n, 50n)], 101n, base)).toMatch(/^No sell-side liquidity/);
  });

  it("says how much the book lists when that is less than the amount", () => {
    const asks = [level(100n, 4n), level(101n, 3n), level(105n, 50n)];
    expect(notAllOrNothing(Side.Buy, 10n, asks, 101n, base)).toMatch(/^The book lists only 7 tMU within the price limit/);
  });

  it("blames the one-transaction bound when the book lists enough", () => {
    const bids = [level(100n, 4n), level(99n, 8n)];
    expect(notAllOrNothing(Side.Sell, 10n, bids, 99n, base)).toMatch(/^One transaction cannot fill all of this order/);
  });

  it("blames the one-transaction bound when the page is full within the limit", () => {
    const asks = Array.from({ length: MAX_OB_LEVELS }, (_, i) => level(100n + BigInt(i), 1n));
    expect(notAllOrNothing(Side.Buy, 50n, asks, 200n, base)).toMatch(/^One transaction cannot fill all of this order/);
  });
});

describe("placedBy", () => {
  const log = (address: `0x${string}`, topics: `0x${string}`[], data: `0x${string}`) => ({ address, topics, data });
  const trade = (amount: bigint) =>
    log(
      MARKET,
      encodeEventTopics({ abi: dlobAbi, eventName: "Trade", args: { buyOrderId: 1, sellOrderId: 2 } }) as `0x${string}`[],
      encodeAbiParameters([{ type: "uint96" }, { type: "uint128" }], [10n ** 18n, amount]),
    );
  const rested = (amount: bigint) =>
    log(
      MARKET,
      encodeEventTopics({ abi: dlobAbi, eventName: "OrderPlaced", args: { orderId: 3, owner: FROM } }) as `0x${string}`[],
      encodeAbiParameters(
        [{ type: "bytes32" }, { type: "uint8" }, { type: "uint96" }, { type: "uint128" }, { type: "uint32" }, { type: "uint64" }],
        [ZERO, 0, 10n ** 18n, amount, 0, 0n],
      ),
    );

  it("adds what the order filled and what rests", () => {
    expect(placedBy([trade(6n), trade(4n), rested(5n)], MARKET)).toBe(15n);
  });

  it("ignores other contracts' events and events it cannot decode", () => {
    const transfer = log(MARKET.replace("aa", "cc") as `0x${string}`, trade(9n).topics, trade(9n).data);
    expect(placedBy([trade(3n), transfer, log(MARKET, [`0x${"00".repeat(32)}`], "0x")], MARKET)).toBe(3n);
  });
});
