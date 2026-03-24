import { useTradeFormStore } from "../../stores/trade-form";
import { useWalletStore } from "../../stores/wallet";
import { useMarketStore } from "../../stores/market";
import { useTokenBalance } from "../../hooks/use-token-balance";
import { Side } from "../../types/market";
import { formatTokenAmount } from "../../lib/format";

export function AmountInput() {
  const { amount, setAmount, side } = useTradeFormStore();
  const h160 = useWalletStore((s) => s.h160);
  const market = useMarketStore((s) => s.selectedMarket);

  const baseSymbol = market?.base.symbol ?? "token";
  const baseDecimals = market?.base.decimals ?? 18;
  const quoteDecimals = market?.quote.decimals ?? 18;

  // Show balance of the token that will be spent
  const spendToken = side === Side.Buy ? market?.quote : market?.base;
  const spendDecimals = side === Side.Buy ? quoteDecimals : baseDecimals;

  const { data: balance } = useTokenBalance(spendToken?.addr, h160 ?? undefined);

  const handleMax = () => {
    if (balance != null) {
      setAmount(formatTokenAmount(balance, baseDecimals));
    }
  };

  return (
    <div>
      <div className="mb-1 flex items-center justify-between">
        <label className="text-xs text-text-primary">
          Amount ({baseSymbol})
        </label>
        {balance != null && spendToken && (
          <span className="text-xs text-text-muted">
            Bal: {formatTokenAmount(balance, spendDecimals)} {spendToken.symbol}
          </span>
        )}
      </div>
      <div className="relative">
        <input
          type="text"
          inputMode="decimal"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          placeholder="0.00"
          className="w-full rounded-lg border border-border bg-surface-overlay px-3 py-2 pr-20 text-sm text-text-primary outline-none focus:border-brand"
        />
        <div className="absolute right-2 top-1/2 flex -translate-y-1/2 items-center gap-1">
          <button
            onClick={handleMax}
            className="rounded bg-surface px-2 py-0.5 text-[10px] font-medium text-brand hover:text-brand-light"
          >
            MAX
          </button>
          <span className="text-xs font-medium text-text-primary">{baseSymbol}</span>
        </div>
      </div>
    </div>
  );
}
