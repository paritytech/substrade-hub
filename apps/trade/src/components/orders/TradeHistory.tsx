// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: © 2026 Parity Technologies
import { useTradeHistory } from "../../hooks/use-trade-history";
import { useMarketStore } from "../../stores/market";
import { formatTokenAmount, tickToDisplayDecimals } from "../../lib/format";
import { Spinner } from "../ui/Spinner";
import { activeChain } from "../../config/chains";
import { ExternalLink } from "../ui/ExternalLink";

export function TradeHistory() {
  const { data: history, isLoading } = useTradeHistory();
  // The history is oldest first, for the chart; the list reads newest first.
  const trades = history && [...history].reverse();
  const market = useMarketStore((s) => s.selectedMarket);
  const baseDecimals = market?.base.decimals ?? 6;
  const priceDecimals = tickToDisplayDecimals(market?.tickSize ?? 10n ** 18n);

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 border-b border-border px-3 py-2">
        <span className="text-xs font-medium text-text-secondary">
          Recent Trades
        </span>
        {isLoading && <Spinner className="h-3 w-3" />}
      </div>

      <div className="overflow-auto text-xs">
        <table className="w-full">
          <thead>
            <tr className="text-left text-text-muted">
              <th className="px-3 py-1 font-medium">Price</th>
              <th className="px-3 py-1 font-medium">Amount</th>
              <th className="px-3 py-1 font-medium">{activeChain.explorerUrl ? "Explorer" : "Tx"}</th>
            </tr>
          </thead>
          <tbody>
            {trades?.map((trade, i) => (
              <tr key={i} className="hover:bg-surface-overlay">
                <td className="px-3 py-1 text-text-primary">
                  {formatTokenAmount(trade.price, 18, priceDecimals)}
                </td>
                <td className="px-3 py-1">
                  {formatTokenAmount(trade.amount, baseDecimals)}
                </td>
                <td className="px-3 py-1">
                  {/* EVM trades carry a real tx hash (link to /tx/); host-signed trades use a
                      block-index extrinsic id (link to /extrinsic/). */}
                  {activeChain.explorerUrl ? (
                    <ExternalLink
                      href={
                        trade.txHash.startsWith("0x")
                          ? `${activeChain.explorerUrl}/tx/${trade.txHash}`
                          : `${activeChain.explorerUrl}/extrinsic/${trade.txHash}`
                      }
                      className="text-text-secondary hover:text-text-primary underline decoration-dotted"
                    >
                      {shortTxId(trade.txHash)}
                    </ExternalLink>
                  ) : (
                    <span className="text-text-secondary">{shortTxId(trade.txHash)}</span>
                  )}
                </td>
              </tr>
            ))}
            {trades?.length === 0 && (
              <tr>
                <td
                  colSpan={3}
                  className="px-3 py-4 text-center text-text-muted"
                >
                  No recent trades
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function shortTxId(txHash: string): string {
  return txHash.startsWith("0x") ? `${txHash.slice(0, 10)}...` : txHash;
}
