import { useQuery } from "@tanstack/react-query";
import { readContract } from "../lib/contract";
import { getTypedApi } from "../lib/client";
import { dlobFactoryAbi } from "../abi/dlob-factory";
import { dlobAbi } from "../abi/dlob";
import { erc20Abi } from "../abi/erc20";
import { activeChain } from "../config/chains";
import { filterKnownQuoteMarkets, isNonZeroAddress } from "../lib/markets";
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

async function fetchMarkets(): Promise<MarketInfo[]> {
  const factory = activeChain.factoryAddress;
  // Not deployed on this network yet (see networks.json): no markets, and no call to the zero address.
  if (!isNonZeroAddress(factory)) return [];
  const count = (await readContract(
    dlobFactoryAbi,
    "getMarketCount",
    [],
    factory,
  )) as bigint;

  const markets: MarketInfo[] = [];
  for (let i = 0n; i < count; i++) {
    const marketAddr = (await readContract(
      dlobFactoryAbi,
      "getMarketAt",
      [i],
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

    const [base, quote] = await Promise.all([
      fetchTokenInfo(baseAddr),
      fetchTokenInfo(quoteAddr),
    ]);

    markets.push({
      address: marketAddr,
      base,
      quote,
      tickSize,
      minOrderSize,
      maxOrderSize,
    });
  }

  return filterKnownQuoteMarkets(markets, activeChain.knownQuote.addr);
}

export function useMarkets() {
  return useQuery({
    queryKey: ["markets"],
    queryFn: fetchMarkets,
    staleTime: 60_000,
    refetchInterval: 60_000,
  });
}
