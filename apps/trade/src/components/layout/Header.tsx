import { MarketSelector } from "../market/MarketSelector";
import { MarketInfo } from "../market/MarketInfo";
import { WalletButton } from "../wallet/WalletButton";

export function Header() {
  return (
    <header className="flex items-center justify-between border-b border-border bg-surface px-4 py-2">
      <div className="flex items-center gap-4">
        <h1 className="text-lg font-bold text-brand">SubsTrade</h1>
        <MarketSelector />
        <MarketInfo />
      </div>
      <WalletButton />
    </header>
  );
}
