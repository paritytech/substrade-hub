import { SideToggle } from "./SideToggle";
import { PriceInput } from "./PriceInput";
import { AmountInput } from "./AmountInput";
import { useTradeFormStore } from "../../stores/trade-form";
import { useWalletStore } from "../../stores/wallet";
import { useMarketStore } from "../../stores/market";
import { orderErrorText, usePlaceOrder } from "../../hooks/use-place-order";
import { useBestPrices } from "../../hooks/use-best-prices";
import { useOrderBook } from "../../hooks/use-order-book";
import {
  DEFAULT_SLIPPAGE_BPS,
  MAX_PRICE_IMPACT_BPS,
  estimateMarketOrder,
} from "../../lib/market-order";
import { useTokenBalance } from "../../hooks/use-token-balance";
import { FundingNotice } from "../wallet/FundingNotice";
import {
  parseTokenAmount,
  quoteAmountCeil,
  formatTokenAmount,
  tickToDisplayDecimals,
  hasMarketLiquidity,
} from "../../lib/format";
import { Side } from "../../types/market";
import { Spinner } from "../ui/Spinner";
import { Amount } from "../ui/Amount";

export function TradeForm() {
  const { side, orderType, setOrderType, price, amount, reset } =
    useTradeFormStore();
  const { h160 } = useWalletStore();
  const market = useMarketStore((s) => s.selectedMarket);
  const placeOrder = usePlaceOrder();
  const { data: bestPrices } = useBestPrices();
  // A market order fills against the opposite side: asks for a buy, bids for a sell.
  const { data: oppositeBook } = useOrderBook(side === Side.Buy ? Side.Sell : Side.Buy);
  const { data: quoteBalance } = useTokenBalance(market?.quote.addr, h160 ?? undefined);
  const { data: baseBalance } = useTokenBalance(market?.base.addr, h160 ?? undefined);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!amount) return;
    placeOrder.mutate(
      { side, orderType, price, amount, limitPrice: marketEstimate?.limitPrice },
      { onSuccess: () => reset() },
    );
  };

  // Calculate estimated total for limit orders
  const baseDecimals = market?.base.decimals ?? 18;
  const quoteDecimals = market?.quote.decimals ?? 18;
  const priceDecimals = tickToDisplayDecimals(market?.tickSize ?? 10n ** 18n);
  let estimatedTotal = "";
  if (orderType === "limit" && price && amount) {
    try {
      const p = parseTokenAmount(price);
      const a = parseTokenAmount(amount, baseDecimals);
      estimatedTotal = formatTokenAmount(quoteAmountCeil(a, p), quoteDecimals, priceDecimals);
    } catch {
      // Invalid input
    }
  }

  // Market orders: estimate against the visible book, with the price limit the order will carry.
  let marketEstimate: ReturnType<typeof estimateMarketOrder> = null;
  let marketAmount = 0n;
  if (orderType === "market" && amount && oppositeBook) {
    try {
      marketAmount = parseTokenAmount(amount, baseDecimals);
      if (marketAmount > 0n) marketEstimate = estimateMarketOrder(side, marketAmount, oppositeBook);
    } catch {
      // Invalid input
    }
  }
  const slippagePercent = Number(DEFAULT_SLIPPAGE_BPS) / 100;
  const maxImpactPercent = Number(MAX_PRICE_IMPACT_BPS) / 100;

  const isBuy = side === Side.Buy;
  // Cheap UX hint: a market order fills against the opposite side, so disable submit when that side is
  // visibly empty. This uses cached best prices and does NOT account for lazily-expired orders; the
  // authoritative expiry-aware check is a pre-submit simulation in usePlaceOrder.
  const noLiquidity =
    orderType === "market" &&
    bestPrices !== undefined &&
    !hasMarketLiquidity(side, bestPrices.bestBid, bestPrices.bestAsk);
  const buttonColor = isBuy
    ? "bg-buy hover:bg-buy/80"
    : "bg-sell hover:bg-sell/80";
  const buttonLabel = isBuy ? "Buy" : "Sell";

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-3 p-3">
      <SideToggle />

      {/* Order type tabs */}
      <div className="flex gap-2 text-xs">
        <button
          type="button"
          onClick={() => setOrderType("limit")}
          className={`rounded px-3 py-1 ${
            orderType === "limit"
              ? "bg-surface-overlay text-text-primary"
              : "text-text-muted hover:text-text-secondary"
          }`}
        >
          Limit
        </button>
        <button
          type="button"
          onClick={() => setOrderType("market")}
          className={`rounded px-3 py-1 ${
            orderType === "market"
              ? "bg-surface-overlay text-text-primary"
              : "text-text-muted hover:text-text-secondary"
          }`}
        >
          Market
        </button>
      </div>

      {h160 && market && (
        <div className="rounded-lg bg-surface-overlay px-3 py-2">
          <div className="mb-1 text-xs font-medium uppercase tracking-wide text-text-muted">
            Available
          </div>
          <div className="flex items-center justify-between">
            <span className="text-sm text-text-secondary">{market.quote.symbol}</span>
            <span className="text-lg font-semibold text-text-primary">
              {quoteBalance !== undefined ? <Amount value={quoteBalance} decimals={quoteDecimals} /> : "—"}
            </span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-sm text-text-secondary">{market.base.symbol}</span>
            <span className="text-lg font-semibold text-text-primary">
              {baseBalance !== undefined ? <Amount value={baseBalance} decimals={baseDecimals} /> : "—"}
            </span>
          </div>
        </div>
      )}

      {orderType === "limit" && <PriceInput />}
      <AmountInput />

      {estimatedTotal && (
        <div className="rounded-lg border border-border bg-surface-overlay px-3 py-2">
          <div className="flex items-center justify-between">
            <span className="text-xs text-text-primary">
              {isBuy ? "You pay" : "You receive"}
            </span>
            <span className="text-sm font-medium text-text-primary">
              {estimatedTotal} {market?.quote.symbol}
            </span>
          </div>
        </div>
      )}

      {marketEstimate && (
        <div className="rounded-lg border border-border bg-surface-overlay px-3 py-2 text-xs">
          <div className="flex items-center justify-between">
            <span className="text-text-primary">{isBuy ? "You pay about" : "You receive about"}</span>
            <span className="text-sm font-medium text-text-primary">
              {formatTokenAmount(marketEstimate.quote, quoteDecimals, priceDecimals)} {market?.quote.symbol}
            </span>
          </div>
          <div className="mt-1 flex items-center justify-between text-text-secondary">
            <span>Average price</span>
            <span>{formatTokenAmount(marketEstimate.averagePrice, 18, priceDecimals)}</span>
          </div>
          <div className="mt-1 flex items-center justify-between text-text-secondary">
            <span>
              {isBuy ? "Pays at most" : "Sells at least at"} ({slippagePercent}% slippage)
            </span>
            <span>{formatTokenAmount(marketEstimate.limitPrice, 18, priceDecimals)}</span>
          </div>
          {marketEstimate.fillable < marketAmount && (
            <div className="mt-1.5 text-text-secondary">
              Only <Amount value={marketEstimate.fillable} decimals={baseDecimals} />{" "}
              {market?.base.symbol} can fill within {maxImpactPercent}% of the best price; the rest
              is returned unfilled.
            </div>
          )}
        </div>
      )}

      {noLiquidity && (
        <div className="rounded border border-border bg-surface-overlay px-2 py-1.5 text-xs text-text-secondary">
          No {isBuy ? "sell-side" : "buy-side"} liquidity to fill a market {isBuy ? "buy" : "sell"} right
          now — place a limit order instead.
        </div>
      )}

      <FundingNotice />

      {placeOrder.error && (
        <div className="rounded bg-sell-dim px-2 py-1.5 text-xs text-sell">
          {orderErrorText(placeOrder.error)}
        </div>
      )}

      <button
        type="submit"
        disabled={!h160 || !amount || noLiquidity || (orderType === "market" && !marketEstimate)}
        className={`flex items-center justify-center gap-2 rounded-lg py-2.5 text-sm font-medium text-white disabled:opacity-60 ${buttonColor}`}
      >
        {placeOrder.isPending && <Spinner className="h-4 w-4" />}
        {!h160 ? "Connect Wallet" : `${buttonLabel} ${market?.base.symbol ?? ""}`}
      </button>
    </form>
  );
}
