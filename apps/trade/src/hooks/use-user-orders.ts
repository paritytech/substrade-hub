// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: © 2026 Parity Technologies
import { useQuery } from "@tanstack/react-query";
import { readContract } from "../lib/contract";
import { dlobAbi } from "../abi/dlob";
import { useMarketStore } from "../stores/market";
import { useWalletStore } from "../stores/wallet";
import { POLL_INTERVAL_MS } from "../config/constants";
import { activeChain } from "../config/chains";
import { isOpenOrder } from "../lib/orders";
import { type Order } from "../types/order";
import { Side } from "../types/market";

// Order struct from contract: (owner, side, status, price, remainingAmount, originalAmount, originAccount, expireTimestamp)
type RawOrder = {
  owner: `0x${string}`;
  side: number;
  status: number;
  price: bigint;
  remainingAmount: bigint;
  originalAmount: bigint;
  originAccount: `0x${string}`;
  expireTimestamp: bigint;
};

/** Most new order ids read per fetch. Older ids a fetch skips are read later by the backfill. */
export const SCAN_WINDOW = 500;
/** Most skipped ids read per fetch, newest first, until every id has been read once. */
export const BACKFILL_BATCH = 200;
/** Order reads sent at once. */
const READ_BATCH = 50;

/**
 * What a fetch carries over to the next one, per network, market and account. Order ids only grow, an
 * order's owner never changes, and a filled or cancelled order never reopens, so each id is read once
 * and only the account's open orders are read again.
 */
interface ScanState {
  /** Highest order id already read. */
  lastScannedId: number;
  /** The account's orders that were open when last read. */
  tracked: number[];
  /** Inclusive id ranges skipped by a fetch and not read yet; the backfill reads them. */
  unread: Array<[number, number]>;
}

export interface UserOrders {
  orders: Order[];
  /** Skipped ids remain unread, so an older open order of the account may still be missing. */
  scanningOlder: boolean;
}

const freshState = (): ScanState => ({ lastScannedId: 0, tracked: [], unread: [] });

const isRange = (r: unknown): r is [number, number] =>
  Array.isArray(r) && r.length === 2 && r.every(Number.isInteger) && r[0] <= r[1];

/**
 * Take up to `max` ids from `unread`, newest first. Returns the ids and the ranges left, newest first.
 */
export function takeBackfill(
  unread: ReadonlyArray<[number, number]>,
  max: number,
): { ids: number[]; left: Array<[number, number]> } {
  const left = unread.map(([lo, hi]) => [lo, hi] as [number, number]).sort((a, b) => b[1] - a[1]);
  const ids: number[] = [];
  while (ids.length < max && left.length) {
    const range = left[0]!;
    while (ids.length < max && range[1] >= range[0]) ids.push(range[1]--);
    if (range[1] < range[0]) left.shift();
  }
  return { ids, left };
}

const memoryStates = new Map<string, ScanState>();

function loadState(key: string): ScanState | null {
  try {
    const raw = localStorage.getItem(key);
    if (raw) {
      const s = JSON.parse(raw) as Partial<ScanState>;
      if (
        Number.isInteger(s.lastScannedId) &&
        Array.isArray(s.tracked) &&
        s.tracked.every(Number.isInteger) &&
        Array.isArray(s.unread) &&
        s.unread.every(isRange)
      ) {
        return s as ScanState;
      }
    }
  } catch {
    /* storage unavailable or corrupt: use the in-memory state */
  }
  return memoryStates.get(key) ?? null;
}

function saveState(key: string, state: ScanState): void {
  memoryStates.set(key, state);
  try {
    localStorage.setItem(key, JSON.stringify(state));
  } catch {
    /* storage unavailable: the in-memory state lasts until reload */
  }
}

function toOrder(orderId: number, raw: RawOrder): Order {
  return {
    orderId,
    side: raw.side as Side,
    price: raw.price,
    amount: raw.remainingAmount,
    filled: raw.originalAmount - raw.remainingAmount,
    originAccount: raw.originAccount,
    settlementAccount: "0x" as `0x${string}`, // not in Order struct
    destParaId: 0,
    expireTimestamp: raw.expireTimestamp,
    isActive: true,
  };
}

/**
 * The account's open orders. Reads the order ids created since the previous fetch (at most
 * `SCAN_WINDOW`), up to `BACKFILL_BATCH` of the ids earlier fetches skipped, and the account's orders
 * that were still open, so the cost follows the new orders and the account's own, whatever the market's
 * total order count. Once the backfill is done, every id has been read once.
 */
export async function fetchUserOrders(
  marketAddr: `0x${string}`,
  account: { h160: `0x${string}`; originAccount: `0x${string}` },
): Promise<UserOrders> {
  const key = `substrade:open-orders:${activeChain.name}:${marketAddr}:${account.h160}:${account.originAccount}`.toLowerCase();
  const maxId = Number(await readContract(dlobAbi, "nextOrderId", [], marketAddr)) - 1;

  let state = loadState(key) ?? freshState();
  // Fewer orders than already read: the market was reset, so the saved ids describe other orders.
  if (maxId < state.lastScannedId) state = freshState();
  const fromId = Math.max(state.lastScannedId + 1, maxId - SCAN_WINDOW + 1, 1);
  const skipped: Array<[number, number]> =
    fromId > state.lastScannedId + 1 ? [[state.lastScannedId + 1, fromId - 1]] : [];
  const backfill = takeBackfill([...state.unread, ...skipped], BACKFILL_BATCH);

  const ids = new Set(state.tracked);
  for (let id = fromId; id <= maxId; id++) ids.add(id);
  for (const id of backfill.ids) ids.add(id);
  const toRead = [...ids];

  // A failed read fails the fetch, so no id is marked read without being read; the next poll retries.
  const raws: RawOrder[] = [];
  for (let i = 0; i < toRead.length; i += READ_BATCH) {
    const batch = toRead.slice(i, i + READ_BATCH);
    raws.push(
      ...((await Promise.all(
        batch.map((id) => readContract(dlobAbi, "getOrder", [id], marketAddr)),
      )) as RawOrder[]),
    );
  }

  const orders: Order[] = [];
  toRead.forEach((id, i) => {
    // Open = Active AND not fully filled (the DLOB doesn't flip status to Filled on a full fill).
    if (isOpenOrder(raws[i]!, account)) orders.push(toOrder(id, raws[i]!));
  });
  orders.sort((a, b) => a.orderId - b.orderId);

  saveState(key, { lastScannedId: maxId, tracked: orders.map((o) => o.orderId), unread: backfill.left });
  return { orders, scanningOlder: backfill.left.length > 0 };
}

export function useUserOrders() {
  const market = useMarketStore((s) => s.selectedMarket);
  const h160 = useWalletStore((s) => s.h160);
  const originAccount = useWalletStore((s) => s.originAccount);

  return useQuery({
    queryKey: ["userOrders", market?.address, h160, originAccount],
    queryFn: () => fetchUserOrders(market!.address, { h160: h160!, originAccount: originAccount! }),
    enabled: !!market && !!h160 && !!originAccount,
    refetchInterval: POLL_INTERVAL_MS * 2,
  });
}
