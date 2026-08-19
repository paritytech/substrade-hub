import { useQuery } from "@tanstack/react-query";
import { getTypedApi } from "../lib/client";
import { useMarketStore } from "../stores/market";
import { useChartStore, RANGE_BLOCKS } from "../stores/chart";
import { POLL_INTERVAL_MS } from "../config/constants";
import { activeChain } from "../config/chains";
import type { TradeEvent } from "../types/trade";
import { decodeEventLog, toHex } from "viem";
import { dlobAbi } from "../abi/dlob";

// topic0 of the DLOB `Trade(uint32 indexed, uint32 indexed, uint96, uint128)` event.
const TRADE_TOPIC = "0x73e4731f0cea3899ce6476355a198e3e4520fd9850a8418a06b56e4cfc4acc87";

// Trade history is merged from two complementary sources:
//   1. eth_getLogs (indexed, cheap over a wide block range) surfaces every EVM-origin trade — the
//      bootstrap seed/trade history and anything placed via eth_transact. This is what fills the candle
//      chart, which needs deep history that a block-by-block scan can't reach.
//   2. A bounded substrate `Revive.ContractEmitted` scan surfaces host-signed (.dot / SubWallet) trades
//      that go through pallet_revive.call, which eth_getLogs does NOT index.
// Either source can be unavailable (e.g. direct RPC fetch blocked in a strict host, or the host client
// not ready), so each is guarded independently and we merge whatever we get. Full deep history for
// host-only trades still needs an indexer.
const HOST_SCAN_BLOCKS = 200;
const MAX_TRADES = 200;
const BATCH = 20;

// ---- Source 1: EVM logs (indexed, deep history) -----------------------------------

async function ethRpc(method: string, params: unknown[] = []): Promise<unknown> {
  const res = await fetch(activeChain.rpcUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const json = (await res.json()) as { result?: unknown; error?: { message: string } };
  if (json.error) throw new Error(json.error.message);
  return json.result;
}

async function fetchEvmTrades(
  marketAddr: `0x${string}`,
  lookbackBlocks: number,
): Promise<TradeEvent[]> {
  const blockHex = (await ethRpc("eth_blockNumber")) as string;
  const current = parseInt(blockHex, 16);
  const start = Math.max(1, current - lookbackBlocks);
  const logs = (await ethRpc("eth_getLogs", [
    {
      address: marketAddr,
      topics: [TRADE_TOPIC],
      fromBlock: `0x${start.toString(16)}`,
      toBlock: "latest",
    },
  ])) as Array<{
    data: `0x${string}`;
    topics: `0x${string}`[];
    blockNumber: string;
    transactionHash: string;
    transactionIndex: string;
  }>;

  // Batch the unique block timestamps (seconds) so candles bucket on wall-clock time.
  const uniqueBlocks = [...new Set(logs.map((l) => l.blockNumber))];
  const ts = new Map<string, number>();
  await Promise.all(
    uniqueBlocks.map(async (bn) => {
      const block = (await ethRpc("eth_getBlockByNumber", [bn, false]).catch(() => null)) as
        | { timestamp?: string }
        | null;
      if (block?.timestamp) ts.set(bn, parseInt(block.timestamp, 16));
    }),
  );

  const out: TradeEvent[] = [];
  for (const log of logs) {
    try {
      const dec = decodeEventLog({
        abi: dlobAbi,
        data: log.data,
        topics: log.topics as [`0x${string}`, ...`0x${string}`[]],
      });
      if (dec.eventName !== "Trade") continue;
      const a = dec.args as { buyOrderId: number; sellOrderId: number; price: bigint; amount: bigint };
      const bn = parseInt(log.blockNumber, 16);
      out.push({
        blockNumber: bn,
        txIndex: parseInt(log.transactionIndex, 16),
        txHash: log.transactionHash,
        buyOrderId: Number(a.buyOrderId),
        sellOrderId: Number(a.sellOrderId),
        price: a.price,
        amount: a.amount,
        timestamp: ts.get(log.blockNumber) ?? bn,
      });
    } catch {
      /* not a decodable Trade — skip */
    }
  }
  return out;
}

// ---- Source 2: substrate ContractEmitted scan (host-signed trades) -----------------

/** A ContractEmitted payload as bytes-carrying values (Binary in the typed API). */
interface ContractLog {
  contract: { asHex(): string };
  topics: { asHex(): string }[];
  data: { asHex(): string };
}

function toHexData(d: { asHex(): string }): `0x${string}` {
  if (typeof d?.asHex === "function") return d.asHex() as `0x${string}`;
  return toHex(Uint8Array.from(Object.values(d as unknown as Record<string, number>)));
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

type Cached = { lastBlock: number; trades: TradeEvent[] };
const hostCache = new Map<string, Cached>();

async function fetchHostTrades(marketAddr: `0x${string}`): Promise<TradeEvent[]> {
  const api = getTypedApi();
  const marketLower = marketAddr.toLowerCase();
  const current = Number(await api.query.System.Number.getValue());
  const prev = hostCache.get(marketAddr);
  const from = prev ? prev.lastBlock + 1 : Math.max(1, current - HOST_SCAN_BLOCKS);
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
  hostCache.set(marketAddr, { lastBlock: to >= from ? to : prev?.lastBlock ?? current - 1, trades: capped });
  return capped;
}

// ---- Merge -------------------------------------------------------------------------

// A trade is uniquely identified by the block it settled in and the order pair + size it matched.
// EVM logs and the substrate scan overlap on recent EVM trades; this dedups them.
const tradeKey = (t: TradeEvent) => `${t.blockNumber}:${t.buyOrderId}:${t.sellOrderId}:${t.amount}`;

async function fetchTradeHistory(
  marketAddr: `0x${string}`,
  lookbackBlocks: number,
): Promise<TradeEvent[]> {
  const [evm, host] = await Promise.all([
    fetchEvmTrades(marketAddr, lookbackBlocks).catch((e) => {
      console.warn("[tradeHistory] eth_getLogs unavailable:", e);
      return [] as TradeEvent[];
    }),
    fetchHostTrades(marketAddr).catch((e) => {
      console.warn("[tradeHistory] substrate scan failed:", e);
      return [] as TradeEvent[];
    }),
  ]);

  const seen = new Set<string>();
  const merged: TradeEvent[] = [];
  for (const t of [...evm, ...host]) {
    const k = tradeKey(t);
    if (seen.has(k)) continue;
    seen.add(k);
    merged.push(t);
  }
  merged.sort((a, b) => a.timestamp - b.timestamp);
  return merged.slice(-MAX_TRADES);
}

export function useTradeHistory() {
  const market = useMarketStore((s) => s.selectedMarket);
  const timeRange = useChartStore((s) => s.timeRange);
  const lookbackBlocks = RANGE_BLOCKS[timeRange];
  return useQuery({
    queryKey: ["tradeHistory", market?.address, timeRange],
    queryFn: () => fetchTradeHistory(market!.address, lookbackBlocks),
    enabled: !!market,
    refetchInterval: POLL_INTERVAL_MS * 2,
  });
}
