import { useViewStore } from "../stores/view";
import { useMarketStore } from "../stores/market";
import { useMarkets } from "../hooks/use-markets";
import { useWalletStore } from "../stores/wallet";
import { useFaucetState, useClaimFaucet, isFaucetConfigured } from "../hooks/use-faucet";
import { activeChain } from "../config/chains";
import { formatTokenAmount, groupThousands } from "../lib/format";
import { Spinner } from "./ui/Spinner";
import { FundingNotice } from "./wallet/FundingNotice";
import { useFunding } from "../hooks/use-funding";
import type { MarketInfo } from "../types/market";
import { useQueries } from "@tanstack/react-query";
import { tokenBalanceQuery } from "../hooks/use-token-balance";
import { tradeHistoryQuery } from "../hooks/use-trade-history";
import type { TradeEvent } from "../types/trade";
import { portfolioTokens, portfolioTotal, valueAt, type PortfolioToken } from "../lib/markets";
import { Amount } from "./ui/Amount";

function formatCooldown(secs: number): string {
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  if (h > 0) return m > 0 ? `${h}h ${m}m` : `${h}h`;
  if (m > 0) return `${m}m`;
  return `${secs}s`;
}

function FaucetCard() {
  const h160 = useWalletStore((s) => s.h160);
  const { symbol, decimals } = activeChain.knownQuote;
  const { data: state } = useFaucetState();
  const claim = useClaimFaucet();
  const { low: needsNative, token } = useFunding();

  if (!isFaucetConfigured()) {
    return (
      <div className="rounded-xl border border-border bg-surface-raised p-5">
        <h3 className="text-sm font-semibold text-text-primary">Test {symbol} faucet</h3>
        <p className="mt-1 text-sm text-text-muted">Coming soon.</p>
      </div>
    );
  }

  const cooldownLeft = state ? Number(state.cooldownLeft) : 0;
  const onCooldown = cooldownLeft > 0;

  return (
    <div className="rounded-xl border border-border bg-surface-raised p-5">
      <h3 className="text-sm font-semibold text-text-primary">Test {symbol} faucet</h3>
      <p className="mt-1 text-sm text-text-secondary">
        {state?.drip !== undefined
          ? `Claim ${groupThousands(formatTokenAmount(state.drip, decimals, 0))} ${symbol} to trade with.`
          : `Claim test ${symbol} to trade with.`}{" "}
        {state?.cooldown !== undefined
          ? `Once per account every ${formatCooldown(Number(state.cooldown))}.`
          : ""}
      </p>
      <button
        onClick={() => claim.mutate()}
        disabled={!h160 || needsNative || onCooldown || claim.isPending}
        className="mt-3 flex w-full items-center justify-center gap-2 rounded-lg bg-brand py-2.5 text-sm font-medium text-white hover:bg-brand-light disabled:opacity-50"
      >
        {claim.isPending && <Spinner className="h-4 w-4" />}
        {!h160
          ? "Connect a wallet to claim"
          : needsNative
            ? `Add ${token?.symbol ?? "native token"} to your account first`
            : onCooldown
            ? `Claim again in ${formatCooldown(cooldownLeft)}`
            : `Get test ${symbol}`}
      </button>
    </div>
  );
}

function MarketsCard() {
  const { data: markets, isLoading, isError, refetch } = useMarkets();
  const selectMarket = useMarketStore((s) => s.selectMarket);
  const setView = useViewStore((s) => s.setView);

  const openMarket = (m: MarketInfo) => {
    selectMarket(m);
    setView("trade");
  };

  return (
    <div className="rounded-xl border border-border bg-surface-raised p-5">
      <h3 className="text-sm font-semibold text-text-primary">Markets</h3>
      {isLoading ? (
        <div className="flex justify-center py-4">
          <Spinner className="h-4 w-4" />
        </div>
      ) : isError && !markets ? (
        <div className="mt-1 flex items-center justify-between gap-3">
          <p className="text-sm text-text-muted">Couldn't load the markets.</p>
          <button onClick={() => void refetch()} className="text-xs text-brand">
            Retry
          </button>
        </div>
      ) : !markets || markets.length === 0 ? (
        <p className="mt-1 text-sm text-text-muted">No markets available yet.</p>
      ) : (
        <ul className="mt-3 space-y-2">
          {markets.map((m) => (
            <li key={m.address}>
              <button
                onClick={() => openMarket(m)}
                className="flex w-full items-center justify-between rounded-lg border border-border px-4 py-3 hover:bg-surface-overlay"
              >
                <span className="text-sm font-medium text-text-primary">
                  {m.base.symbol} / {m.quote.symbol}
                </span>
                <span className="text-xs text-brand">Trade</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** One token's wallet balance and its value in the quote token, with a link to its market. */
function PortfolioRow({
  entry,
  balance,
  value,
  onTrade,
}: {
  entry: PortfolioToken;
  balance: bigint | undefined;
  value: bigint | null | undefined;
  onTrade: (m: MarketInfo) => void;
}) {
  const { market } = entry;
  const quote = activeChain.knownQuote;
  return (
    <li className="grid grid-cols-[1fr_auto_auto_2.5rem] items-center gap-4 rounded-lg border border-border px-4 py-3 text-sm">
      <span className="font-medium text-text-primary">{entry.token.symbol}</span>
      <span className="text-right text-text-primary">
        {balance !== undefined ? <Amount value={balance} decimals={entry.token.decimals} /> : "—"}
      </span>
      <span className="min-w-20 text-right text-text-secondary">
        {value === undefined ? "—" : value === null ? "N/A" : <Amount value={value} decimals={quote.decimals} />}
      </span>
      {market ? (
        <button onClick={() => onTrade(market)} className="text-right text-xs text-brand">
          Trade
        </button>
      ) : (
        <span />
      )}
    </li>
  );
}

/**
 * The connected account's wallet balance of every token in the listed markets, each valued in the
 * quote token at its market's last trade, with an estimated total.
 */
function PortfolioCard() {
  const h160 = useWalletStore((s) => s.h160);
  const { data: markets } = useMarkets();
  const selectMarket = useMarketStore((s) => s.selectMarket);
  const setView = useViewStore((s) => s.setView);
  const openMarket = (m: MarketInfo) => {
    selectMarket(m);
    setView("trade");
  };

  const quote = activeChain.knownQuote;
  const entries = portfolioTokens(quote, markets ?? []);
  // Shared with the trade form and the chart, so either view finds these cached.
  const balances = useQueries({ queries: entries.map((e) => tokenBalanceQuery(e.token.addr, h160 ?? undefined)) });
  const histories = useQueries({ queries: entries.map((e) => tradeHistoryQuery(e.market?.address)) });

  const values = entries.map((e, i) => {
    const balance = balances[i]!.data as bigint | undefined;
    if (balance === undefined) return undefined;
    if (!e.market) return balance;
    const trades = histories[i]!.data as TradeEvent[] | undefined;
    if (trades === undefined) return undefined;
    return valueAt(balance, trades.at(-1)?.price ?? null);
  });
  const loaded = values.every((v) => v !== undefined);
  const { total, partial } = portfolioTotal(values.filter((v) => v !== undefined));

  return (
    <div className="rounded-xl border border-border bg-surface-raised p-5 sm:col-span-2">
      <h3 className="text-sm font-semibold text-text-primary">Portfolio</h3>
      {!h160 ? (
        <p className="mt-1 text-sm text-text-muted">Connect a wallet to see your balances.</p>
      ) : (
        <>
          <div className="mt-3 grid grid-cols-[1fr_auto_auto_2.5rem] gap-4 px-4 text-xs text-text-muted">
            <span>Token</span>
            <span className="text-right">In wallet</span>
            <span className="min-w-20 text-right">Value ({quote.symbol})</span>
            <span />
          </div>
          <ul className="mt-2 space-y-2">
            {entries.map((entry, i) => (
              <PortfolioRow
                key={entry.token.addr}
                entry={entry}
                balance={balances[i]!.data as bigint | undefined}
                value={values[i]}
                onTrade={openMarket}
              />
            ))}
          </ul>
          <div className="mt-3 flex items-center justify-between px-4 text-sm">
            <span className="font-medium text-text-primary">Total value (est.)</span>
            <span className="font-semibold text-text-primary">
              {loaded ? (
                <>
                  <Amount value={total} decimals={quote.decimals} /> {quote.symbol}
                </>
              ) : (
                "—"
              )}
            </span>
          </div>
          <p className="mt-3 text-xs text-text-muted">
            Each token is valued at its market's last trade.
            {partial && " N/A: no trade in the last 30 days, so it is left out of the total."}
          </p>
          <p className="mt-1 text-xs text-text-muted">
            Tokens in your resting orders are held by the market until they fill or you cancel, so they are not
            counted here.
          </p>
        </>
      )}
    </div>
  );
}

export function Home() {
  return (
    <div className="flex-1 overflow-auto">
      <div className="mx-auto max-w-3xl px-6 py-10">
        <section className="text-center">
          <h1 className="font-display text-4xl font-bold text-text-primary">SubsTrade Hub</h1>
          <p className="mt-3 text-lg font-medium text-text-secondary">
            A fully on-chain limit order book DEX on Polkadot Asset Hub.
          </p>
          <p className="mx-auto mt-3 max-w-2xl text-sm text-text-muted">
            Matching and settlement run on-chain via pallet-revive — no bridges, no custody. It's natively
            multi-chain: an order can be placed and settled from any parachain via XCM in a single
            extrinsic (cross-chain UI coming). For now, grab test tUSD from the faucet and trade tokenized
            stocks on Asset Hub.
          </p>
        </section>

        <div className="mt-8 empty:hidden">
          <FundingNotice />
        </div>

        <div className="mt-8 grid gap-4 sm:grid-cols-2">
          <FaucetCard />
          <MarketsCard />
          <PortfolioCard />
        </div>
      </div>
    </div>
  );
}
