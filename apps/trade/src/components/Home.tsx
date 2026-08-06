import { useViewStore } from "../stores/view";
import { useMarketStore } from "../stores/market";
import { useMarkets } from "../hooks/use-markets";
import { useWalletStore } from "../stores/wallet";
import { useFaucetState, useClaimFaucet, isFaucetConfigured } from "../hooks/use-faucet";
import { activeChain } from "../config/chains";
import { formatTokenAmount, groupThousands } from "../lib/format";
import { Spinner } from "./ui/Spinner";
import type { MarketInfo } from "../types/market";

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
        disabled={!h160 || onCooldown || claim.isPending}
        className="mt-3 flex w-full items-center justify-center gap-2 rounded-lg bg-brand py-2.5 text-sm font-medium text-white hover:bg-brand-light disabled:opacity-50"
      >
        {claim.isPending && <Spinner className="h-4 w-4" />}
        {!h160
          ? "Connect a wallet to claim"
          : onCooldown
            ? `Claim again in ${formatCooldown(cooldownLeft)}`
            : `Get test ${symbol}`}
      </button>
    </div>
  );
}

function MarketsCard() {
  const { data: markets, isLoading } = useMarkets();
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

        <div className="mt-8 grid gap-4 sm:grid-cols-2">
          <FaucetCard />
          <MarketsCard />
        </div>
      </div>
    </div>
  );
}
