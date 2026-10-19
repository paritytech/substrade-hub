import { Header } from "./components/layout/Header";
import { ConnectionBanner } from "./components/layout/ConnectionBanner";
import { Home } from "./components/Home";
import { TradingGrid } from "./components/layout/TradingGrid";
import { Toasts } from "./components/ui/Toasts";
import { useWalletReconnect } from "./hooks/use-wallet-reconnect";
import { useHostReconnect } from "./hooks/use-host-reconnect";
import { useHostConnection } from "./hooks/use-host-connection";
import { useViewStore } from "./stores/view";

export function App() {
  useWalletReconnect();
  useHostReconnect();
  useHostConnection();
  const view = useViewStore((s) => s.view);
  return (
    <div className="flex h-screen flex-col overflow-hidden">
      <Header />
      <ConnectionBanner />
      {view === "home" ? <Home /> : <TradingGrid />}
      <Toasts />
    </div>
  );
}
