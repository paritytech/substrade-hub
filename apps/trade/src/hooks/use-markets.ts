import { useQuery } from "@tanstack/react-query";
import { readContract } from "../lib/contract";
import { getTypedApi } from "../lib/client";
import { dlobFactoryAbi } from "../abi/dlob-factory";
import { dlobAbi } from "../abi/dlob";
import { erc20Abi } from "../abi/erc20";
import { activeChain } from "../config/chains";
import { isKnownQuote, isNonZeroAddress } from "../lib/markets";
import type { MarketInfo, TokenInfo } from "../types/market";

/**
 * Extract pallet-assets asset ID from an ERC20 precompile address.
 * Precompile format: 0x<assetId 4 bytes>00000000000000000000000001200000
 */
function erc20ToAssetId(addr: `0x${string}`): number | null {
  const lower = addr.toLowerCase();
  if (!lower.endsWith("00000000000000000000000001200000")) return null;
  return parseInt(lower.slice(2, 10), 16);
}

async function fetchTokenInfo(addr: `0x${string}`): Promise<TokenInfo> {
  // Pallet-assets ERC20 precompiles don't support name()/symbol()/decimals().
  // Query pallet-assets metadata via Substrate instead.
  const assetId = erc20ToAssetId(addr);
  if (assetId != null) {
    const api = getTypedApi();
    const meta = await api.query.Assets.Metadata.getValue(assetId, {
      at: "best",
    });
    if (meta) {
      return {
        addr,
        name: new TextDecoder().decode(meta.name),
        symbol: new TextDecoder().decode(meta.symbol),
        decimals: meta.decimals,
      };
    }
  }
  // Fallback: try ERC20 calls (works for non-precompile tokens)
  const [name, symbol, decimals] = await Promise.all([
    readContract(erc20Abi, "name", [], addr) as Promise<string>,
    readContract(erc20Abi, "symbol", [], addr) as Promise<string>,
    readContract(erc20Abi, "decimals", [], addr) as Promise<number>,
  ]);
  return { addr, name, symbol, decimals };
}

/** Most markets the list reads. Markets past it are not shown. */
export const MAX_MARKETS = 50;

/**
 * Load market `index` of the factory. Returns null for a market quoted in another token: only markets
 * quoted in the known tUSD are shown, so other markets never reach a token lookup.
 */
async function fetchMarket(factory: `0x${string}`, index: bigint): Promise<MarketInfo | null> {
  const marketAddr = (await readContract(
    dlobFactoryAbi,
    "getMarketAt",
    [index],
    factory,
  )) as `0x${string}`;

  // getMarketInfo returns (address base, address quote, uint96 tick, uint96 minSize, uint128 maxSize)
  const info = (await readContract(
    dlobAbi,
    "getMarketInfo",
    [],
    marketAddr,
  )) as [
    `0x${string}`, // base address
    `0x${string}`, // quote address
    bigint, // tickSize
    bigint, // minOrderSize
    bigint, // maxOrderSize
  ];

  const [baseAddr, quoteAddr, tickSize, minOrderSize, maxOrderSize] = info;
  if (!isKnownQuote(quoteAddr, activeChain.knownQuote.addr)) return null;

  const [base, quote] = await Promise.all([
    fetchTokenInfo(baseAddr),
    fetchTokenInfo(quoteAddr),
  ]);

  return {
    address: marketAddr,
    base,
    quote,
    tickSize,
    minOrderSize,
    maxOrderSize,
  };
}

/**
 * Load the factory's markets concurrently, each on its own: a market that fails to load is skipped
 * and the others are still shown. Fails only when the count cannot be read or every market failed,
 * so an outage reads as an error instead of an empty exchange.
 */
export async function fetchMarkets(): Promise<MarketInfo[]> {
  const factory = activeChain.factoryAddress;
  // Not deployed on this network yet (see networks.json): no markets, and no call to the zero address.
  if (!isNonZeroAddress(factory)) return [];
  const count = (await readContract(
    dlobFactoryAbi,
    "getMarketCount",
    [],
    factory,
  )) as bigint;
  const shown = count < BigInt(MAX_MARKETS) ? Number(count) : MAX_MARKETS;

  const results = await Promise.allSettled(
    Array.from({ length: shown }, (_, i) => fetchMarket(factory, BigInt(i))),
  );
  const markets: MarketInfo[] = [];
  let failed = 0;
  for (const [i, r] of results.entries()) {
    if (r.status === "fulfilled") {
      if (r.value) markets.push(r.value);
    } else {
      failed++;
      console.warn(`[markets] skipped market #${i}:`, r.reason);
    }
  }
  if (shown > 0 && failed === shown) {
    throw new Error("Could not load any market", { cause: (results[0] as PromiseRejectedResult).reason });
  }
  return markets;
}

export function useMarkets() {
  return useQuery({
    queryKey: ["markets"],
    queryFn: fetchMarkets,
    staleTime: 60_000,
    refetchInterval: 60_000,
  });
}
