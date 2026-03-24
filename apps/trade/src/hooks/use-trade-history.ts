import { useQuery } from "@tanstack/react-query";
import { useMarketStore } from "../stores/market";
import { useChartStore, RANGE_BLOCKS } from "../stores/chart";
import { POLL_INTERVAL_MS } from "../config/constants";
import { activeChain } from "../config/chains";
import type { TradeEvent } from "../types/trade";
import { decodeEventLog } from "viem";
import { dlobAbi } from "../abi/dlob";

const TRADE_TOPIC =
  "0x73e4731f0cea3899ce6476355a198e3e4520fd9850a8418a06b56e4cfc4acc87";

async function fetchTradeHistory(
  marketAddr: `0x${string}`,
  lookbackBlocks: number,
): Promise<TradeEvent[]> {
  const trades: TradeEvent[] = [];

  try {
    const blockHex = (await ethRpc("eth_blockNumber")) as string;
    const currentBlock = parseInt(blockHex, 16);
    const startBlock = Math.max(1, currentBlock - lookbackBlocks);

    const logs = (await ethRpc("eth_getLogs", [
      {
        address: marketAddr,
        topics: [TRADE_TOPIC],
        fromBlock: `0x${startBlock.toString(16)}`,
        toBlock: "latest",
      },
    ])) as Array<{
      data: `0x${string}`;
      topics: `0x${string}`[];
      blockNumber: string;
      transactionIndex: string;
      logIndex: string;
    }>;

    // Batch-fetch unique block timestamps
    const uniqueBlocks = [...new Set(logs.map((l) => l.blockNumber))];
    const blockTimestamps = new Map<string, number>();
    await Promise.all(
      uniqueBlocks.map(async (blockNum) => {
        try {
          const block = (await ethRpc("eth_getBlockByNumber", [
            blockNum,
            false,
          ])) as { timestamp?: string } | null;
          if (block?.timestamp) {
            blockTimestamps.set(blockNum, parseInt(block.timestamp, 16));
          }
        } catch {
          // skip
        }
      }),
    );

    for (const log of logs) {
      try {
        const decoded = decodeEventLog({
          abi: dlobAbi,
          data: log.data,
          topics: log.topics as [
            signature: `0x${string}`,
            ...args: `0x${string}`[],
          ],
        });

        if (decoded.eventName === "Trade") {
          const args = decoded.args as {
            buyOrderId: number;
            sellOrderId: number;
            price: bigint;
            amount: bigint;
          };

          const blockNum = parseInt(log.blockNumber, 16);
          // Use block timestamp, fall back to block number as synthetic timestamp
          const timestamp =
            blockTimestamps.get(log.blockNumber) ?? blockNum;

          trades.push({
            blockNumber: blockNum,
            txIndex: parseInt(log.transactionIndex, 16),
            buyOrderId: args.buyOrderId,
            sellOrderId: args.sellOrderId,
            price: args.price,
            amount: args.amount,
            timestamp,
          });
        }
      } catch {
        // Decode failed
      }
    }
  } catch (err) {
    console.error("[fetchTradeHistory] error:", err);
  }

  return trades.sort((a, b) => a.timestamp - b.timestamp);
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
