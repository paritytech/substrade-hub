import { Header } from "./components/layout/Header";
import { TradingGrid } from "./components/layout/TradingGrid";
import { Toasts } from "./components/ui/Toasts";
import { useWalletReconnect } from "./hooks/use-wallet-reconnect";
import { useHostReconnect } from "./hooks/use-host-reconnect";

export function App() {
  useWalletReconnect();
  useHostReconnect();
  return (
    <div className="flex h-screen flex-col overflow-hidden">
      <Header />
      <TradingGrid />
      <Toasts />
    </div>
  );
}
