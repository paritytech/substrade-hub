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

  return (
    <div className="grid flex-1 grid-cols-[1fr_320px_300px] grid-rows-[1fr_240px] gap-px overflow-hidden bg-border">
      {/* Price Chart */}
      <div className="overflow-hidden bg-surface">
        <PriceChart />
      </div>

      {/* Order Book */}
      <div className="row-span-2 overflow-hidden bg-surface">
        <OrderBook />
      </div>

      {/* Trade Form */}
      <div className="row-span-2 overflow-y-auto bg-surface">
        <TradeForm />
      </div>

      {/* Bottom panel: Orders + Trade History */}
      <div className="flex bg-surface">
        <div className="flex-1 overflow-hidden border-r border-border">
          <OpenOrders />
        </div>
        <div className="flex-1 overflow-hidden">
          <TradeHistory />
        </div>
      </div>
    </div>
  );
}
