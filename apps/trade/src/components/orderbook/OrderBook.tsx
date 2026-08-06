import { OrderBookSide } from "./OrderBookSide";
import { useBestPrices } from "../../hooks/use-best-prices";
import { useOrderBook } from "../../hooks/use-order-book";
import { useMarketStore } from "../../stores/market";
import { Side } from "../../types/market";
import { NumberDisplay } from "../ui/NumberDisplay";
import { Spinner } from "../ui/Spinner";
import { formatTokenAmount, tickToDisplayDecimals } from "../../lib/format";

/**
 * A prominent best bid/ask readout that sits directly against the spread, in that side's color.
 * Laid out like the spread bar — an uppercase label pinned left, the price centered — so all three
 * values (best ask / spread / best bid) line up vertically. `border` draws the thin line separating
 * it from the adjacent table.
 */
function BestPrice({
  label,
  price,
  className,
  border,
  priceDecimals,
}: {
  label: string;
  price: bigint | undefined;
  className: string;
  border: string;
  priceDecimals: number;
}) {
  return (
    <div className={`relative flex items-center justify-center px-3 py-1.5 ${border}`}>
      <span className="absolute left-3 text-xs font-medium uppercase text-text-muted">{label}</span>
      <span className={`text-base font-semibold tabular-nums ${className}`}>
        {price !== undefined ? formatTokenAmount(price, 18, priceDecimals) : "--"}
      </span>
    </div>
  );
}

/** Price / Volume column labels — rendered once above the asks and once below the bids. */
function ColumnHeader() {
  return (
    // pr mirrors px-3 (0.75rem) plus the 6px scrollbar gutter reserved on the rows, so "Volume" lines
    // up with the right-aligned numbers below.
    <div className="grid grid-cols-2 gap-1 py-1 pl-3 pr-[calc(0.75rem+6px)] text-xs font-medium uppercase text-text-muted">
      <span>Price</span>
      <span className="text-right">Volume</span>
    </div>
  );
}

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

      {/* Ask column header */}
      <ColumnHeader />

      {/* Asks — content-height (so the header sits right against the rows), capped + scrollable if
          long; bottom-anchored so an overflowing list keeps the lowest (best) ask by the spread */}
      <OrderBookSide
        levels={[...(asks ?? [])].reverse()}
        side={Side.Sell}
        maxTotal={asks?.reduce((s, l) => s + l.totalAmount, 0n) ?? 0n}
        baseDecimals={baseDecimals}
        priceDecimals={priceDecimals}
        anchor="bottom"
      />

      <BestPrice
        label="Best Ask"
        price={prices?.bestAsk}
        className="text-sell"
        border="border-t border-border"
        priceDecimals={priceDecimals}
      />

      {/* Spread bar */}
      <div className="relative flex items-center justify-center border-y border-border py-2.5">
        <span className="absolute left-3 text-xs font-medium uppercase text-text-muted">Spread</span>
        {prices ? (
          <span className="text-lg font-semibold tabular-nums text-text-secondary">
            <NumberDisplay value={prices.spread} displayDecimals={2} />
          </span>
        ) : (
          <span className="text-text-muted">--</span>
        )}
      </div>

      <BestPrice
        label="Best Bid"
        price={prices?.bestBid}
        className="text-buy"
        border="border-b border-border"
        priceDecimals={priceDecimals}
      />

      {/* Bids — content-height, top-anchored so the highest (best) bid hugs the spread and the bid
          header sits right against the last row */}
      <OrderBookSide
        levels={bids ?? []}
        side={Side.Buy}
        maxTotal={bids?.reduce((s, l) => s + l.totalAmount, 0n) ?? 0n}
        baseDecimals={baseDecimals}
        priceDecimals={priceDecimals}
        anchor="top"
      />

      {/* Bid column header (mirrors the ask header at the bottom outer edge) */}
      <ColumnHeader />
    </div>
  );
}
