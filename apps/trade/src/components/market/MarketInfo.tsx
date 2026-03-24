import { useBestPrices } from "../../hooks/use-best-prices";
import { useMarketStore } from "../../stores/market";
import { NumberDisplay } from "../ui/NumberDisplay";

export function MarketInfo() {
  const market = useMarketStore((s) => s.selectedMarket);
  const { data: prices } = useBestPrices();

  if (!market || !prices) return null;

  return (
    <div className="flex items-center gap-4 text-sm">
      <div>
        <span className="text-text-muted">Bid </span>
        <NumberDisplay value={prices.bestBid} className="text-buy" />
      </div>
      <div>
        <span className="text-text-muted">Ask </span>
        <NumberDisplay value={prices.bestAsk} className="text-sell" />
      </div>
      <div>
        <span className="text-text-muted">Spread </span>
        <NumberDisplay value={prices.spread} className="text-text-secondary" />
      </div>
    </div>
  );
}
