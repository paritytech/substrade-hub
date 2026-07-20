import { Header } from "./components/layout/Header";
import { TradingGrid } from "./components/layout/TradingGrid";
import { Toasts } from "./components/ui/Toasts";
import { useWalletReconnect } from "./hooks/use-wallet-reconnect";

export function App() {
  useWalletReconnect();
  return (
    <div className="flex h-screen flex-col overflow-hidden">
      <Header />
      <TradingGrid />
      <Toasts />
    </div>
  );
}
