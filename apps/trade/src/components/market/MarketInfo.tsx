import { useBestPrices } from "../../hooks/use-best-prices";
import { useMarketStore } from "../../stores/market";
import { NumberDisplay } from "../ui/NumberDisplay";
import { activeChain } from "../../config/chains";

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
      <a
        href={`${activeChain.explorerUrl}/account/${market.address}`}
        target="_blank"
        rel="noopener noreferrer"
        className="text-text-secondary hover:text-text-primary text-sm underline decoration-dotted"
      >
        View on Subscan
      </a>
    </div>
  );
}
