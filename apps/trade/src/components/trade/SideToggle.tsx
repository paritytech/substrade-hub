import { Side } from "../../types/market";
import { useTradeFormStore } from "../../stores/trade-form";

export function SideToggle() {
  const { side, setSide } = useTradeFormStore();

  return (
    <div className="grid grid-cols-2 gap-1 rounded-lg bg-surface-overlay p-1">
      <button
        type="button"
        onClick={() => setSide(Side.Buy)}
        className={`rounded-md py-1.5 text-sm font-medium transition-colors ${
          side === Side.Buy
            ? "bg-buy text-white"
            : "text-text-muted hover:text-text-secondary"
        }`}
      >
        Buy
      </button>
      <button
        type="button"
        onClick={() => setSide(Side.Sell)}
        className={`rounded-md py-1.5 text-sm font-medium transition-colors ${
          side === Side.Sell
            ? "bg-sell text-white"
            : "text-text-muted hover:text-text-secondary"
        }`}
      >
        Sell
      </button>
    </div>
  );
}
