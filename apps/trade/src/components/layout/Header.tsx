// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: © 2026 Parity Technologies
import { MarketSelector } from "../market/MarketSelector";
import { MarketInfo } from "../market/MarketInfo";
import { WalletButton } from "../wallet/WalletButton";
import { useViewStore } from "../../stores/view";
import { useWalletStore } from "../../stores/wallet";
import { useTokenBalance } from "../../hooks/use-token-balance";
import { activeChain } from "../../config/chains";
import { Amount } from "../ui/Amount";

/** Persistent wallet-style balance of the quote token (tUSD) — the money you trade with. */
function HeaderBalance() {
  const h160 = useWalletStore((s) => s.h160);
  const { addr, symbol, decimals } = activeChain.knownQuote;
  const { data: balance } = useTokenBalance(addr, h160 ?? undefined);
  if (!h160) return null;
  return (
    <div className="flex items-baseline gap-1.5 rounded-lg bg-surface-raised px-3 py-1.5">
      <span className="text-xs font-medium uppercase tracking-wide text-text-muted">Balance</span>
      <span className="text-lg font-semibold text-text-primary">
        {balance !== undefined ? <Amount value={balance} decimals={decimals} /> : "—"}
      </span>
      <span className="text-sm text-text-secondary">{symbol}</span>
    </div>
  );
}

export function Header() {
  const view = useViewStore((s) => s.view);
  const setView = useViewStore((s) => s.setView);

  const tab = (v: "home" | "trade", label: string) => (
    <button
      onClick={() => setView(v)}
      className={`rounded px-2 py-1 text-sm ${
        view === v ? "text-text-primary" : "text-text-muted hover:text-text-secondary"
      }`}
    >
      {label}
    </button>
  );

  return (
    // Wraps onto a second row on narrow screens (the Polkadot app runs on phones), so the market
    // selector and the wallet button are never pushed off-screen.
    <header className="flex flex-wrap items-center justify-between gap-2 border-b border-border bg-surface px-4 py-2">
      <div className="flex min-w-0 flex-wrap items-center gap-2 sm:gap-4">
        <button onClick={() => setView("home")} className="font-display text-lg font-bold text-brand">
          SubsTrade
        </button>
        <nav className="flex items-center gap-1">
          {tab("home", "Home")}
          {tab("trade", "Trade")}
        </nav>
        {view === "trade" && (
          <>
            <MarketSelector />
            {/* Supplementary price info — desktop only */}
            <div className="hidden lg:block">
              <MarketInfo />
            </div>
          </>
        )}
      </div>
      {/* Wallet-style balance next to the wallet button, in the normal flow so it never overlaps it.
          Hidden on small screens, where the amount field shows the balance an order spends. */}
      <div className="flex items-center gap-2">
        <div className="hidden md:block">
          <HeaderBalance />
        </div>
        <WalletButton />
      </div>
    </header>
  );
}
