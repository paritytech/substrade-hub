import { useQuery } from "@tanstack/react-query";
import { readContract } from "../lib/contract";
import { dlobAbi } from "../abi/dlob";
import { useMarketStore } from "../stores/market";
import { useWalletStore } from "../stores/wallet";
import { POLL_INTERVAL_MS } from "../config/constants";
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

/**
 * Scan order IDs to find the user's active orders.
 * Without an indexer, we iterate from 1..nextOrderId and filter by originAccount.
 */
async function fetchUserOrders(
  marketAddr: `0x${string}`,
  originAccount: `0x${string}`,
): Promise<Order[]> {
  const nextId = Number(
    await readContract(dlobAbi, "nextOrderId", [], marketAddr),
  );

  const orders: Order[] = [];
  const batchSize = 10;

  for (let start = 1; start < nextId; start += batchSize) {
    const end = Math.min(start + batchSize, nextId);
    const promises = [];
    for (let i = start; i < end; i++) {
      promises.push(
        readContract(dlobAbi, "getOrder", [i], marketAddr).catch(() => null),
      );
    }
    const results = await Promise.all(promises);
    for (let i = 0; i < results.length; i++) {
      const raw = results[i] as RawOrder | null;
      if (!raw) continue;

      const isActive = raw.status === 0; // OrderStatus.Active = 0
      if (
        isActive &&
        raw.originAccount.toLowerCase() === originAccount.toLowerCase()
      ) {
        orders.push({
          orderId: start + i,
          side: raw.side as Side,
          price: raw.price,
          amount: raw.remainingAmount,
          filled: raw.originalAmount - raw.remainingAmount,
          originAccount: raw.originAccount,
          settlementAccount: "0x" as `0x${string}`, // not in Order struct
          destParaId: 0,
          expireTimestamp: raw.expireTimestamp,
          isActive: true,
        });
      }
    }
  }

  return orders;
}

export function useUserOrders() {
  const market = useMarketStore((s) => s.selectedMarket);
  const originAccount = useWalletStore((s) => s.originAccount);

  return useQuery({
    queryKey: ["userOrders", market?.address, originAccount],
    queryFn: () => fetchUserOrders(market!.address, originAccount!),
    enabled: !!market && !!originAccount,
    refetchInterval: POLL_INTERVAL_MS * 2,
  });
}
