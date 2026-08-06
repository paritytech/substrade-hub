import { Header } from "./components/layout/Header";
import { Home } from "./components/Home";
import { TradingGrid } from "./components/layout/TradingGrid";
import { Toasts } from "./components/ui/Toasts";
import { useWalletReconnect } from "./hooks/use-wallet-reconnect";
import { useHostReconnect } from "./hooks/use-host-reconnect";
import { useViewStore } from "./stores/view";

export function App() {
  useWalletReconnect();
  useHostReconnect();
  const view = useViewStore((s) => s.view);
  return (
    <div className="flex h-screen flex-col overflow-hidden">
      <Header />
      {view === "home" ? <Home /> : <TradingGrid />}
      <Toasts />
    </div>
  );
}
