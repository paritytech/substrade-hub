import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { readContract } = vi.hoisted(() => ({ readContract: vi.fn() }));
vi.mock("../lib/contract", () => ({ readContract }));
vi.mock("../config/chains", () => ({ activeChain: { name: "testnet" } }));

import { fetchUserOrders, SCAN_WINDOW } from "./use-user-orders";

const H160 = "0xbbfa164356c66a791c4c5e2596fe5486594c6c68" as const;
const ORIGIN = `0x${"ab".repeat(32)}` as const;
const ACCOUNT = { h160: H160, originAccount: ORIGIN };
const STRANGER = "0x00000000000000000000000000000000000000aa";

let market = 0;
/** A fresh market address per test, so no saved scan state is shared between tests. */
const nextMarket = () => `0x${(++market).toString(16).padStart(40, "0")}` as `0x${string}`;

/**
 * A market with `count` orders. Ids in `mine` belong to the account and are open unless listed in
 * `closed`; every other id belongs to someone else. Returns the ids `getOrder` was called with.
 */
function chain(count: number, mine: number[], closed: number[] = []) {
  const reads: number[] = [];
  readContract.mockImplementation(async (_abi, fn: string, args: unknown[]) => {
    if (fn === "nextOrderId") return BigInt(count + 1);
    const id = Number(args[0]);
    reads.push(id);
    const own = mine.includes(id);
    return {
      owner: own ? H160 : STRANGER,
      side: 0,
      status: 0,
      price: 220n * 10n ** 18n,
      remainingAmount: own && closed.includes(id) ? 0n : 1_000_000n,
      originalAmount: 1_000_000n,
      originAccount: own ? ORIGIN : `0x${"cd".repeat(32)}`,
      expireTimestamp: 0n,
    };
  });
  return reads;
}

const store = new Map<string, string>();
beforeEach(() => {
  readContract.mockReset();
  store.clear();
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
  });
});
afterEach(() => vi.unstubAllGlobals());

describe("fetchUserOrders", () => {
  it("reads only the newest ids on a first load, and reports the skipped ones", async () => {
    const m = nextMarket();
    const reads = chain(1200, [100, 1000]);
    const { orders, hasGap } = await fetchUserOrders(m, ACCOUNT);
    expect(reads).toHaveLength(SCAN_WINDOW);
    expect(Math.min(...reads)).toBe(1200 - SCAN_WINDOW + 1);
    expect(orders.map((o) => o.orderId)).toEqual([1000]);
    expect(hasGap).toBe(true);
  });

  it("reads every id of a small market and reports no gap", async () => {
    chain(30, [3, 20]);
    const { orders, hasGap } = await fetchUserOrders(nextMarket(), ACCOUNT);
    expect(orders.map((o) => o.orderId)).toEqual([3, 20]);
    expect(hasGap).toBe(false);
  });

  it("later reads only the new ids and the account's open orders", async () => {
    const m = nextMarket();
    chain(300, [5, 120]);
    await fetchUserOrders(m, ACCOUNT);

    const reads = chain(303, [5, 120, 302]);
    const { orders } = await fetchUserOrders(m, ACCOUNT);
    expect(reads.sort((a, b) => a - b)).toEqual([5, 120, 301, 302, 303]);
    expect(orders.map((o) => o.orderId)).toEqual([5, 120, 302]);
  });

  it("stops reading an order once it is filled or cancelled", async () => {
    const m = nextMarket();
    chain(50, [7, 9]);
    await fetchUserOrders(m, ACCOUNT);
    chain(50, [7, 9], [7]);
    expect((await fetchUserOrders(m, ACCOUNT)).orders.map((o) => o.orderId)).toEqual([9]);

    const reads = chain(50, [7, 9], [7]);
    await fetchUserOrders(m, ACCOUNT);
    expect(reads).toEqual([9]);
  });

  it("ignores an order sent by another account with this account's originAccount", async () => {
    const m = nextMarket();
    readContract.mockImplementation(async (_abi, fn: string, args: unknown[]) =>
      fn === "nextOrderId"
        ? 11n
        : {
            owner: Number(args[0]) === 6 ? STRANGER : H160,
            side: 0,
            status: 0,
            price: 220n * 10n ** 18n,
            remainingAmount: [4, 6].includes(Number(args[0])) ? 1_000_000n : 0n,
            originalAmount: 1_000_000n,
            originAccount: ORIGIN,
            expireTimestamp: 0n,
          },
    );
    expect((await fetchUserOrders(m, ACCOUNT)).orders.map((o) => o.orderId)).toEqual([4]);
  });

  it("after a long absence reads at most the window plus the tracked orders, and keeps them", async () => {
    const m = nextMarket();
    chain(150, [10]);
    await fetchUserOrders(m, ACCOUNT);

    const reads = chain(10_150, [10]);
    const { orders, hasGap } = await fetchUserOrders(m, ACCOUNT);
    expect(reads).toHaveLength(SCAN_WINDOW + 1);
    expect(orders.map((o) => o.orderId)).toEqual([10]);
    expect(hasGap).toBe(true);
  });

  it("resumes from the saved state after a reload", async () => {
    const m = nextMarket();
    const key = `substrade:open-orders:testnet:${m}:${H160}:${ORIGIN}`.toLowerCase();
    store.set(key, JSON.stringify({ lastScannedId: 80, tracked: [12], hasGap: false }));
    const reads = chain(82, [12]);
    const { orders } = await fetchUserOrders(m, ACCOUNT);
    expect(reads.sort((a, b) => a - b)).toEqual([12, 81, 82]);
    expect(orders.map((o) => o.orderId)).toEqual([12]);
  });

  it("starts over when the market has fewer orders than were read (a reset)", async () => {
    const m = nextMarket();
    chain(400, [350]);
    await fetchUserOrders(m, ACCOUNT);

    const reads = chain(20, [2]);
    const { orders } = await fetchUserOrders(m, ACCOUNT);
    expect(reads.sort((a, b) => a - b)).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
    expect(orders.map((o) => o.orderId)).toEqual([2]);
  });

  it("fails without marking ids read when a read fails, so the next poll reads them", async () => {
    const m = nextMarket();
    chain(20, [15]);
    readContract.mockImplementationOnce(async () => 21n).mockRejectedValueOnce(new Error("rpc down"));
    await expect(fetchUserOrders(m, ACCOUNT)).rejects.toThrow("rpc down");

    const reads = chain(20, [15]);
    expect((await fetchUserOrders(m, ACCOUNT)).orders.map((o) => o.orderId)).toEqual([15]);
    expect(reads).toHaveLength(20);
  });

  it("works without storage", async () => {
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    });
    const m = nextMarket();
    chain(5, [1]);
    await fetchUserOrders(m, ACCOUNT);
    const reads = chain(6, [1]);
    expect((await fetchUserOrders(m, ACCOUNT)).orders.map((o) => o.orderId)).toEqual([1]);
    expect(reads.sort((a, b) => a - b)).toEqual([1, 6]);
  });
});
