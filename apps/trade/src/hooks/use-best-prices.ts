import { useQuery } from "@tanstack/react-query";
import { readContract } from "../lib/contract";
import { dlobAbi } from "../abi/dlob";
import { useMarketStore } from "../stores/market";
import { POLL_INTERVAL_MS } from "../config/constants";
import type { BestPrices } from "../types/market";

async function fetchBestPrices(
  marketAddr: `0x${string}`,
): Promise<BestPrices> {
  // getBestPrices returns (uint96 bid, uint96 ask)
  const result = (await readContract(
    dlobAbi,
    "getBestPrices",
    [],
    marketAddr,
  )) as [bigint, bigint];

  const [bestBid, bestAsk] = result;
  const spread =
    bestAsk > 0n && bestBid > 0n ? bestAsk - bestBid : 0n;

  return { bestBid, bestAsk, spread };
}

export function useBestPrices() {
  const market = useMarketStore((s) => s.selectedMarket);

  return useQuery({
    queryKey: ["bestPrices", market?.address],
    queryFn: () => fetchBestPrices(market!.address),
    enabled: !!market,
    refetchInterval: POLL_INTERVAL_MS,
  });
}
