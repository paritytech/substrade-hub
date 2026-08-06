import { OrderBook } from "../orderbook/OrderBook";
import { TradeForm } from "../trade/TradeForm";
import { OpenOrders } from "../orders/OpenOrders";
import { TradeHistory } from "../orders/TradeHistory";
import { PriceChart } from "../chart/PriceChart";
import { useMarketStore } from "../../stores/market";

export function TradingGrid() {
  const market = useMarketStore((s) => s.selectedMarket);

  if (!market) {
    return (
      <div className="flex flex-1 items-center justify-center text-text-muted">
        Select a market to start trading
      </div>
    );
  }

  // Mobile: a single scrollable column (chart, then buy/sell, then order book, then orders/history) so
  // nothing is hidden. lg+: the fixed three-pane trading grid. Source order is mobile-friendly; explicit
  // lg grid positions keep the desktop layout regardless of source order.
  return (
    <div className="flex flex-1 flex-col gap-px overflow-y-auto bg-border lg:grid lg:grid-cols-[1fr_320px_300px] lg:grid-rows-[1fr_240px] lg:overflow-hidden">
      {/* Price Chart */}
      <div className="h-72 shrink-0 overflow-hidden bg-surface lg:col-start-1 lg:row-start-1 lg:h-auto">
        <PriceChart />
      </div>

      {/* Trade Form (buy/sell) — kept high on mobile so it's reachable without hunting */}
      <div className="shrink-0 overflow-y-auto bg-surface lg:col-start-3 lg:row-span-2 lg:row-start-1">
        <TradeForm />
      </div>

      {/* Order Book */}
      <div className="h-80 shrink-0 overflow-hidden bg-surface lg:col-start-2 lg:row-span-2 lg:row-start-1 lg:h-auto">
        <OrderBook />
      </div>

      {/* Bottom panel: Orders + Trade History (stacked on mobile, side-by-side on sm+) */}
      <div className="flex h-96 shrink-0 flex-col bg-surface sm:h-64 sm:flex-row lg:col-start-1 lg:row-start-2 lg:h-auto">
        <div className="flex-1 overflow-hidden border-b border-border sm:border-b-0 sm:border-r">
          <OpenOrders />
        </div>
        <div className="flex-1 overflow-hidden">
          <TradeHistory />
        </div>
      </div>
    </div>
  );
}
