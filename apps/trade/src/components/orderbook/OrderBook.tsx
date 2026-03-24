import { OrderBookSide } from "./OrderBookSide";
import { useBestPrices } from "../../hooks/use-best-prices";
import { useOrderBook } from "../../hooks/use-order-book";
import { useMarketStore } from "../../stores/market";
import { Side } from "../../types/market";
import { NumberDisplay } from "../ui/NumberDisplay";
import { Spinner } from "../ui/Spinner";
import { tickToDisplayDecimals } from "../../lib/format";

export function OrderBook() {
  const market = useMarketStore((s) => s.selectedMarket);
  const { data: asks, isLoading: asksLoading } = useOrderBook(Side.Sell);
  const { data: bids, isLoading: bidsLoading } = useOrderBook(Side.Buy);
  const { data: prices } = useBestPrices();
  const baseDecimals = market?.base.decimals ?? 18;
  const priceDecimals = tickToDisplayDecimals(market?.tickSize ?? 10n ** 18n);

  const isLoading = asksLoading || bidsLoading;

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b border-border px-3 py-2">
        <span className="text-xs font-medium text-text-secondary">
          Order Book
        </span>
        {isLoading && <Spinner className="h-3 w-3" />}
      </div>

      {/* Header */}
      <div className="grid grid-cols-2 gap-1 px-3 py-1 text-[10px] font-medium uppercase text-text-muted">
        <span>Price</span>
        <span className="text-right">Volume</span>
      </div>

      {/* Asks (reversed so lowest ask is at bottom) */}
      <div className="flex-1 overflow-hidden">
        <OrderBookSide
          levels={[...(asks ?? [])].reverse()}
          side={Side.Sell}
          maxTotal={asks?.reduce((s, l) => s + l.totalAmount, 0n) ?? 0n}
          baseDecimals={baseDecimals}
          priceDecimals={priceDecimals}
        />
      </div>

      {/* Spread bar */}
      <div className="flex items-center justify-center border-y border-border py-1.5 text-xs">
        {prices ? (
          <span className="text-text-secondary">
            Spread:{" "}
            <NumberDisplay value={prices.spread} displayDecimals={2} />
          </span>
        ) : (
          <span className="text-text-muted">--</span>
        )}
      </div>

      {/* Bids */}
      <div className="flex-1 overflow-hidden">
        <OrderBookSide
          levels={bids ?? []}
          side={Side.Buy}
          maxTotal={bids?.reduce((s, l) => s + l.totalAmount, 0n) ?? 0n}
          baseDecimals={baseDecimals}
          priceDecimals={priceDecimals}
        />
      </div>
    </div>
  );
}
