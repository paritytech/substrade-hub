import { useQuery } from "@tanstack/react-query";
import { readContract } from "../lib/contract";
import { dlobAbi } from "../abi/dlob";
import { useMarketStore } from "../stores/market";
import { Side, type OrderBookLevel } from "../types/market";
import { POLL_INTERVAL_MS, MAX_OB_LEVELS } from "../config/constants";

async function fetchOrderBook(
  marketAddr: `0x${string}`,
  side: Side,
  levels: number,
): Promise<OrderBookLevel[]> {
  // getOrderBook returns (uint96[] prices, uint128[] volumes, uint8 count)
  const result = (await readContract(
    dlobAbi,
    "getOrderBook",
    [side, levels],
    marketAddr,
  )) as [bigint[], bigint[], number];

  const [prices, volumes, count] = result;
  const out: OrderBookLevel[] = [];
  for (let i = 0; i < count; i++) {
    out.push({
      price: prices[i]!,
      totalAmount: volumes[i]!,
      orderCount: 0, // not returned by contract
    });
  }
  return out;
}

export function useOrderBook(side: Side) {
  const market = useMarketStore((s) => s.selectedMarket);

  return useQuery({
    queryKey: ["orderBook", market?.address, side],
    queryFn: () => fetchOrderBook(market!.address, side, MAX_OB_LEVELS),
    enabled: !!market,
    refetchInterval: POLL_INTERVAL_MS,
  });
}
