import { useQuery } from "@tanstack/react-query";
import { getTypedApi } from "../lib/client";
import { useMarketStore } from "../stores/market";
import { HISTORY_BLOCKS } from "../stores/chart";
import { POLL_INTERVAL_MS } from "../config/constants";
import { activeChain } from "../config/chains";
import type { TradeEvent } from "../types/trade";
import { decodeEventLog, toHex } from "viem";
import { dlobAbi } from "../abi/dlob";
import { isInHost } from "../lib/host/detect";
import { requestRemoteAccess } from "../lib/host/remote";

// topic0 of the DLOB `Trade(uint32 indexed, uint32 indexed, uint96, uint128)` event.
const TRADE_TOPIC = "0x73e4731f0cea3899ce6476355a198e3e4520fd9850a8418a06b56e4cfc4acc87";

// Trade history (the Recent Trades list and the candle chart) comes from two sources, merged and
// deduplicated:
//
//   1. eth-rpc `eth_getLogs`, the primary source. It covers the whole chart (30 days), because eth-rpc
//      keeps its own index of contract logs.
//   2. A scan of `Revive.ContractEmitted` in recent blocks, through the chain client. It catches trades
//      signed through a host or a Substrate wallet, which go through `pallet_revive.call`.
//
// Why eth-rpc and not the chain client for history: trade events live in each block's
// `System.Events` storage, and nodes prune state after a few hundred blocks, so no chain client can
// read events older than roughly that, whatever it is connected to. Inside a host the chain client is
// a light client that only follows blocks from the moment it connects, and a block-by-block scan costs
// one round trip per block. So the on-chain scan is bounded to `HOST_SCAN_BLOCKS`, and only eth-rpc,
// with its own log index, can fill a chart.
//
// Inside a host, the eth-rpc call is outbound HTTP, which hosts block unless the product holds the
// `Remote` permission for that domain (see `lib/host/remote`). It is requested the first time history
// is fetched; if it is denied or the call fails, the chart shows what the on-chain scan found.
const HOST_SCAN_BLOCKS = 200;
const MAX_TRADES = 2000;
const BATCH = 20;

/**
 * Largest block span requested in one `eth_getLogs` call. The eth-rpc serves a ~350k-block span and
 * rejects a 1.3M one, so the 30-day history (~1.3M blocks) is fetched in chunks of this size.
 */
const LOG_CHUNK_BLOCKS = 300_000;

/** Inclusive `[start, end]` block spans covering `from..to`, each at most `size` blocks long. */
export function blockChunks(from: number, to: number, size: number): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (let start = from; start <= to; start += size) out.push([start, Math.min(start + size - 1, to)]);
  return out;
}

// ---- Source 1: EVM logs (indexed, deep history) -----------------------------------

/** Assumed block time when fewer than two blocks have a known timestamp. */
const DEFAULT_BLOCK_SECONDS = 2;

/**
 * Timestamps (seconds) for `blocks`: the known one where available, otherwise extrapolated from the
 * nearest known block at the block rate measured across the known blocks. Empty when nothing is known.
 */
export function estimateTimestamps(blocks: number[], known: Map<number, number>): Map<number, number> {
  const anchors = [...known].sort(([a], [b]) => a - b);
  const out = new Map<number, number>();
  if (anchors.length === 0) return out;
  const [firstBn, firstTs] = anchors[0]!;
  const [lastBn, lastTs] = anchors[anchors.length - 1]!;
  const rate = lastBn > firstBn ? (lastTs - firstTs) / (lastBn - firstBn) : DEFAULT_BLOCK_SECONDS;
  for (const bn of blocks) {
    const exact = known.get(bn);
    if (exact !== undefined) {
      out.set(bn, exact);
      continue;
    }
    const [anchorBn, anchorTs] = anchors.reduce((best, a) => (Math.abs(a[0] - bn) < Math.abs(best[0] - bn) ? a : best));
    out.set(bn, Math.round(anchorTs + (bn - anchorBn) * rate));
  }
  return out;
}

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

type EthLog = {
  data: `0x${string}`;
  topics: `0x${string}`[];
  blockNumber: string;
  transactionHash: string;
  transactionIndex: string;
};

type Cached = { lastBlock: number; trades: TradeEvent[] };
const evmCache = new Map<string, Cached>();

/**
 * Trades from eth-rpc logs over the last `HISTORY_BLOCKS`. The first call per market fetches the whole
 * window in `LOG_CHUNK_BLOCKS` chunks; later calls fetch only the blocks since the previous one, since
 * past logs never change.
 */
async function fetchEvmTrades(marketAddr: `0x${string}`): Promise<TradeEvent[]> {
  if (isInHost() && !(await requestRemoteAccess())) {
    throw new Error("network access to eth-rpc was not granted by the host");
  }
  const blockHex = (await ethRpc("eth_blockNumber")) as string;
  const current = parseInt(blockHex, 16);
  const prev = evmCache.get(marketAddr);
  const from = prev ? prev.lastBlock + 1 : Math.max(1, current - HISTORY_BLOCKS);
  if (from > current) return prev?.trades ?? [];

  const logs: EthLog[] = [];
  for (const [start, end] of blockChunks(from, current, LOG_CHUNK_BLOCKS)) {
    const chunk = (await ethRpc("eth_getLogs", [
      {
        address: marketAddr,
        topics: [TRADE_TOPIC],
        fromBlock: `0x${start.toString(16)}`,
        toBlock: `0x${end.toString(16)}`,
      },
    ])) as EthLog[];
    logs.push(...chunk);
  }

  // Batch the unique block timestamps (seconds) so candles bucket on wall-clock time. Pruned nodes
  // cannot answer for old blocks, so those are estimated from the blocks that did answer.
  const uniqueBlocks = [...new Set(logs.map((l) => l.blockNumber))];
  const known = new Map<number, number>();
  await Promise.all(
    [...uniqueBlocks, blockHex].map(async (bn) => {
      const block = (await ethRpc("eth_getBlockByNumber", [bn, false]).catch(() => null)) as
        | { timestamp?: string }
        | null;
      if (block?.timestamp) known.set(parseInt(bn, 16), parseInt(block.timestamp, 16));
    }),
  );
  const ts = estimateTimestamps(
    uniqueBlocks.map((bn) => parseInt(bn, 16)),
    known,
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
        timestamp: ts.get(bn) ?? bn,
      });
    } catch {
      /* not a decodable Trade — skip */
    }
  }
  const trades = [...(prev?.trades ?? []), ...out].slice(-MAX_TRADES);
  evmCache.set(marketAddr, { lastBlock: current, trades });
  return trades;
}

// ---- Source 2: substrate ContractEmitted scan (host-signed trades) -----------------

/**
 * A ContractEmitted payload. polkadot-api v2 hands fixed-size byte fields (the H160 contract, H256
 * topics) over as hex strings and variable-length bytes (`data`) as a Uint8Array.
 */
interface ContractLog {
  contract: unknown;
  topics: unknown[];
  data: unknown;
}

/** Hex for a byte field in any shape polkadot-api returns it: hex string, Uint8Array or Binary-like. */
function bytesToHex(v: unknown): `0x${string}` {
  if (typeof v === "string") return v as `0x${string}`;
  if (v instanceof Uint8Array) return toHex(v);
  if (typeof (v as { asHex?: unknown })?.asHex === "function") return (v as { asHex(): `0x${string}` }).asHex();
  throw new Error(`unexpected byte field: ${String(v)}`);
}

export function decodeTradesInBlock(
  events: ReadonlyArray<{ event: { type: string; value: { type: string; value: unknown } }; phase: { type: string; value?: number } }>,
  marketLower: string,
  blockNumber: number,
): TradeEvent[] {
  const out: TradeEvent[] = [];
  for (const e of events) {
    if (e.event.type !== "Revive" || e.event.value?.type !== "ContractEmitted") continue;
    const log = e.event.value.value as ContractLog;
    if (bytesToHex(log.contract).toLowerCase() !== marketLower) continue;
    const topics = log.topics.map(bytesToHex);
    if ((topics[0] ?? "").toLowerCase() !== TRADE_TOPIC) continue;
    try {
      const dec = decodeEventLog({
        abi: dlobAbi,
        topics: topics as [`0x${string}`, ...`0x${string}`[]],
        data: bytesToHex(log.data),
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

async function fetchTradeHistory(marketAddr: `0x${string}`): Promise<TradeEvent[]> {
  const [evm, host] = await Promise.all([
    fetchEvmTrades(marketAddr).catch((e) => {
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

/** The selected market's trades over the last 30 days, oldest first. Ranges filter it client-side. */
export function useTradeHistory() {
  const market = useMarketStore((s) => s.selectedMarket);
  return useQuery({
    queryKey: ["tradeHistory", market?.address],
    queryFn: () => fetchTradeHistory(market!.address),
    enabled: !!market,
    refetchInterval: POLL_INTERVAL_MS * 2,
  });
}
