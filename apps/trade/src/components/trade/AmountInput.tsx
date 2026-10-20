import { useTradeFormStore } from "../../stores/trade-form";
import { useWalletStore } from "../../stores/wallet";
import { useMarketStore } from "../../stores/market";
import { useTokenBalance } from "../../hooks/use-token-balance";
import { Side } from "../../types/market";
import { Amount } from "../ui/Amount";
import { maxOrderAmount, parseTokenAmount } from "../../lib/format";
import { formatUnits } from "viem";

export function AmountInput() {
  const { amount, setAmount, side, orderType, price } = useTradeFormStore();
  const h160 = useWalletStore((s) => s.h160);
  const market = useMarketStore((s) => s.selectedMarket);

  const baseSymbol = market?.base.symbol ?? "token";
  const baseDecimals = market?.base.decimals ?? 18;
  const quoteDecimals = market?.quote.decimals ?? 18;

  // Show balance of the token that will be spent
  const spendToken = side === Side.Buy ? market?.quote : market?.base;
  const spendDecimals = side === Side.Buy ? quoteDecimals : baseDecimals;

  const { data: balance } = useTokenBalance(spendToken?.addr, h160 ?? undefined);

  let limitPrice: bigint | undefined;
  try {
    limitPrice = price ? parseTokenAmount(price) : undefined;
  } catch {
    // An unfinished price: no Max until it parses.
  }
  const max = balance != null ? maxOrderAmount(side, orderType, balance, limitPrice) : undefined;

  return (
    <div>
      <div className="mb-1 flex items-center justify-between">
        <label className="text-xs text-text-primary">
          Amount ({baseSymbol})
        </label>
        {balance != null && spendToken && (
          <span className="text-xs text-text-muted">
            Balance: <Amount value={balance} decimals={spendDecimals} /> {spendToken.symbol}
            {max !== undefined && max > 0n && (
              <button
                type="button"
                onClick={() => setAmount(formatUnits(max, baseDecimals))}
                className="ml-2 font-medium text-brand hover:text-brand-light"
              >
                Max
              </button>
            )}
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
          className="w-full rounded-lg border border-border bg-surface-overlay px-3 py-2 pr-14 text-sm text-text-primary outline-none focus:border-brand"
        />
        <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs font-medium text-text-primary">
          {baseSymbol}
        </span>
      </div>
    </div>
  );
}
