import { useTradeFormStore } from "../../stores/trade-form";
import { useMarketStore } from "../../stores/market";
import { alignToTick } from "../../lib/format";
import { parseTokenAmount, formatTokenAmount } from "../../lib/format";

export function PriceInput() {
  const { price, setPrice } = useTradeFormStore();
  const tickSize = useMarketStore((s) => s.selectedMarket?.tickSize);

  const handleBlur = () => {
    if (!price || !tickSize) return;
    try {
      const parsed = parseTokenAmount(price);
      const aligned = alignToTick(parsed, tickSize);
      if (aligned > 0n) {
        setPrice(formatTokenAmount(aligned));
      }
    } catch {
      // Invalid input, leave as-is for user to fix
    }
  };

  const market = useMarketStore((s) => s.selectedMarket);
  const quoteSymbol = market?.quote.symbol ?? "";

  return (
    <div>
      <label className="mb-1 block text-xs text-text-primary">
        Price ({quoteSymbol} per {market?.base.symbol ?? "token"})
      </label>
      <div className="relative">
        <input
          type="text"
          inputMode="decimal"
          value={price}
          onChange={(e) => setPrice(e.target.value)}
          onBlur={handleBlur}
          placeholder="0.00"
          className="w-full rounded-lg border border-border bg-surface-overlay px-3 py-2 pr-16 text-sm text-text-primary outline-none focus:border-brand"
        />
        <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-xs font-medium text-text-primary">
          {quoteSymbol}
        </span>
      </div>
    </div>
  );
}
