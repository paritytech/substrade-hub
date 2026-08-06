import { useQuery } from "@tanstack/react-query";
import { getTypedApi } from "../lib/client";
import { useMarketStore } from "../stores/market";
import { POLL_INTERVAL_MS } from "../config/constants";
import type { TradeEvent } from "../types/trade";
import { decodeEventLog, toHex } from "viem";
import { dlobAbi } from "../abi/dlob";

// topic0 of the DLOB `Trade(uint32 indexed, uint32 indexed, uint96, uint128)` event.
const TRADE_TOPIC = "0x73e4731f0cea3899ce6476355a198e3e4520fd9850a8418a06b56e4cfc4acc87";

// On first load we scan this many recent blocks for Trade events (there is no substrate log index, so
// this is a bounded block-by-block sweep — too large a window makes the first load slow / rate-limited).
// After that, new trades are picked up incrementally as blocks arrive and PERSIST in the panel (capped
// at MAX_TRADES), so a live demo's fills stay visible; full historical trade history needs an indexer.
const BACKFILL_BLOCKS = 400;
const MAX_TRADES = 100;
const BATCH = 20;

/**
 * Trade history sourced from substrate `Revive.ContractEmitted` System events via the host-routed client
 * (NOT eth_getLogs). pallet-revive surfaces every contract log as a ContractEmitted event regardless of
 * whether the tx was EVM (`eth_transact`) or substrate (`pallet_revive.call`); eth_getLogs only indexes
 * the EVM ones, so host-signed (SubWallet / .dot) trades were invisible. This reads them all.
 */
type Cached = { lastBlock: number; trades: TradeEvent[] };
const cache = new Map<string, Cached>();

/** A ContractEmitted payload as bytes-carrying values (Binary in the typed API). */
interface ContractLog {
  contract: { asHex(): string };
  topics: { asHex(): string }[];
  data: { asHex(): string };
}

function decodeTradesInBlock(
  events: ReadonlyArray<{ event: { type: string; value: { type: string; value: unknown } }; phase: { type: string; value?: number } }>,
  marketLower: string,
  blockNumber: number,
): TradeEvent[] {
  const out: TradeEvent[] = [];
  for (const e of events) {
    if (e.event.type !== "Revive" || e.event.value?.type !== "ContractEmitted") continue;
    const log = e.event.value.value as ContractLog;
    if (log.contract.asHex().toLowerCase() !== marketLower) continue;
    const topics = log.topics.map((t) => t.asHex() as `0x${string}`);
    if ((topics[0] ?? "").toLowerCase() !== TRADE_TOPIC) continue;
    try {
      const dec = decodeEventLog({
        abi: dlobAbi,
        topics: topics as [`0x${string}`, ...`0x${string}`[]],
        data: toHexData(log.data),
      });
      if (dec.eventName !== "Trade") continue;
      const a = dec.args as { buyOrderId: number; sellOrderId: number; price: bigint; amount: bigint };
      const txIndex = e.phase.type === "ApplyExtrinsic" ? Number(e.phase.value) : 0;
      out.push({
        blockNumber,
        txIndex,
        txHash: `${blockNumber}-${txIndex}`, // Subscan extrinsic id (no EVM tx hash for substrate calls)
        buyOrderId: Number(a.buyOrderId),
        sellOrderId: Number(a.sellOrderId),
        price: a.price,
        amount: a.amount,
        timestamp: 0, // set by the caller (one Timestamp read per trade-bearing block)
      });
    } catch {
      /* not a decodable Trade — skip */
    }
  }
  return out;
}

function toHexData(d: { asHex(): string }): `0x${string}` {
  if (typeof d?.asHex === "function") return d.asHex() as `0x${string}`;
  return toHex(Uint8Array.from(Object.values(d as unknown as Record<string, number>)));
}

async function fetchTradeHistory(marketAddr: `0x${string}`): Promise<TradeEvent[]> {
  const api = getTypedApi();
  const marketLower = marketAddr.toLowerCase();
  const current = Number(await api.query.System.Number.getValue());
  const prev = cache.get(marketAddr);
  const from = prev ? prev.lastBlock + 1 : Math.max(1, current - BACKFILL_BLOCKS);
  const to = current - 1; // the newest block's hash may not be in System.BlockHash yet
  const trades = prev ? [...prev.trades] : [];

  for (let base = from; base <= to; base += BATCH) {
    const nums: number[] = [];
    for (let n = base; n <= Math.min(base + BATCH - 1, to); n++) nums.push(n);
    const hashes = await Promise.all(
      nums.map((n) => api.query.System.BlockHash.getValue(n).catch(() => null)),
    );
    const perBlock = await Promise.all(
      nums.map(async (n, j) => {
        const hash = hashes[j];
        if (!hash) return [];
        const events = await api.query.System.Events.getValue({ at: hash }).catch(() => []);
        const found = decodeTradesInBlock(events as never, marketLower, n);
        if (found.length) {
          const ms = Number((await api.query.Timestamp.Now.getValue({ at: hash }).catch(() => 0n)) as bigint);
          const secs = ms ? Math.floor(ms / 1000) : n;
          for (const t of found) t.timestamp = secs;
        }
        return found;
      }),
    );
    for (const arr of perBlock) trades.push(...arr);
  }

  const capped = trades.slice(-MAX_TRADES);
  cache.set(marketAddr, { lastBlock: to >= from ? to : prev?.lastBlock ?? current - 1, trades: capped });
  return capped.slice().sort((a, b) => a.timestamp - b.timestamp);
}

export function useTradeHistory() {
  const market = useMarketStore((s) => s.selectedMarket);
  return useQuery({
    queryKey: ["tradeHistory", market?.address],
    queryFn: () => fetchTradeHistory(market!.address),
    enabled: !!market,
    refetchInterval: POLL_INTERVAL_MS * 2,
  });
}
