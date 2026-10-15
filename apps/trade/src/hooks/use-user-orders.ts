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

/** Most new order ids read per fetch. Older ids skipped by a fetch are not read later. */
export const SCAN_WINDOW = 500;
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
  /** Whether a fetch skipped ids, so an older open order of the account may be missing. */
  hasGap: boolean;
}

export interface UserOrders {
  orders: Order[];
  /** Ids were skipped (more than `SCAN_WINDOW` new ones at once), so older open orders may be missing. */
  hasGap: boolean;
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
        typeof s.hasGap === "boolean"
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
 * `SCAN_WINDOW`) plus the account's orders that were still open, so the cost follows the new orders and
 * the account's own, whatever the market's total order count.
 */
export async function fetchUserOrders(
  marketAddr: `0x${string}`,
  account: { h160: `0x${string}`; originAccount: `0x${string}` },
): Promise<UserOrders> {
  const key = `substrade:open-orders:${activeChain.name}:${marketAddr}:${account.h160}:${account.originAccount}`.toLowerCase();
  const maxId = Number(await readContract(dlobAbi, "nextOrderId", [], marketAddr)) - 1;

  let state = loadState(key) ?? { lastScannedId: 0, tracked: [], hasGap: false };
  // Fewer orders than already read: the market was reset, so the saved ids describe other orders.
  if (maxId < state.lastScannedId) state = { lastScannedId: 0, tracked: [], hasGap: false };
  const fromId = Math.max(state.lastScannedId + 1, maxId - SCAN_WINDOW + 1, 1);
  const hasGap = state.hasGap || fromId > state.lastScannedId + 1;

  const ids = [...new Set(state.tracked.filter((id) => id < fromId))];
  for (let id = fromId; id <= maxId; id++) ids.push(id);

  // A failed read fails the fetch, so no id is marked read without being read; the next poll retries.
  const raws: RawOrder[] = [];
  for (let i = 0; i < ids.length; i += READ_BATCH) {
    const batch = ids.slice(i, i + READ_BATCH);
    raws.push(
      ...((await Promise.all(
        batch.map((id) => readContract(dlobAbi, "getOrder", [id], marketAddr)),
      )) as RawOrder[]),
    );
  }

  const orders: Order[] = [];
  ids.forEach((id, i) => {
    // Open = Active AND not fully filled (the DLOB doesn't flip status to Filled on a full fill).
    if (isOpenOrder(raws[i]!, account)) orders.push(toOrder(id, raws[i]!));
  });
  orders.sort((a, b) => a.orderId - b.orderId);

  saveState(key, { lastScannedId: maxId, tracked: orders.map((o) => o.orderId), hasGap });
  return { orders, hasGap };
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
