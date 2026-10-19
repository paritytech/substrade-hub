import { useState, useRef, useEffect } from "react";
import { useMarkets } from "../../hooks/use-markets";
import { useMarketStore } from "../../stores/market";
import { Spinner } from "../ui/Spinner";

export function MarketSelector() {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const { data: markets, isLoading, isError } = useMarkets();
  const { selectedMarket, selectMarket } = useMarketStore();

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  const label = selectedMarket
    ? `${selectedMarket.base.symbol}/${selectedMarket.quote.symbol}`
    : "Select Market";

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center gap-2 rounded-lg border border-border px-3 py-1.5 text-sm font-medium hover:bg-surface-raised"
      >
        {isLoading && <Spinner className="h-3 w-3" />}
        {label}
        <svg
          className={`h-3 w-3 transition-transform ${open ? "rotate-180" : ""}`}
          viewBox="0 0 12 12"
          fill="none"
        >
          <path
            d="M3 4.5L6 7.5L9 4.5"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
          />
        </svg>
      </button>

      {open && (markets || isError) && (
        <div className="absolute left-0 top-full z-40 mt-1 w-56 rounded-lg border border-border bg-surface-raised py-1 shadow-xl">
          {markets?.map((m) => (
            <button
              key={m.address}
              onClick={() => {
                selectMarket(m);
                setOpen(false);
              }}
              className={`w-full px-4 py-2 text-left text-sm hover:bg-surface-overlay ${
                m.address === selectedMarket?.address
                  ? "text-brand"
                  : "text-text-primary"
              }`}
            >
              {m.base.symbol}/{m.quote.symbol}
            </button>
          ))}
          {!markets && (
            <div className="px-4 py-2 text-sm text-text-muted">
              Couldn't load the markets
            </div>
          )}
          {markets?.length === 0 && (
            <div className="px-4 py-2 text-sm text-text-muted">
              No markets found
            </div>
          )}
        </div>
      )}
    </div>
  );
}
