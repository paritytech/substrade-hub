import { useTradeHistory } from "../../hooks/use-trade-history";
import { useMarketStore } from "../../stores/market";
import { formatTokenAmount, tickToDisplayDecimals } from "../../lib/format";
import { Spinner } from "../ui/Spinner";
import { activeChain } from "../../config/chains";

export function TradeHistory() {
  const { data: trades, isLoading } = useTradeHistory();
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
              <th className="px-3 py-1 font-medium">Explorer</th>
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
                  <a
                    href={`${activeChain.explorerUrl}/tx/${trade.txHash}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-text-secondary hover:text-text-primary underline decoration-dotted"
                  >
                    {trade.txHash.slice(0, 6)}...{trade.txHash.slice(-4)}
                  </a>
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
