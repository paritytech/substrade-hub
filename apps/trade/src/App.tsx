import { Header } from "./components/layout/Header";
import { TradingGrid } from "./components/layout/TradingGrid";
import { Toasts } from "./components/ui/Toasts";

export function App() {
  return (
    <div className="flex h-screen flex-col overflow-hidden">
      <Header />
      <TradingGrid />
      <Toasts />
    </div>
  );
}
