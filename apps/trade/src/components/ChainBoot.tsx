import { useEffect, useState, type ReactNode } from "react";
import { initChainClient } from "../lib/client";
import { isInHost } from "../lib/host/detect";
import { Spinner } from "./ui/Spinner";

/**
 * Gate rendering on the chain client being initialized. In a Polkadot host this awaits host detection
 * and picks the host-routed provider; standalone it resolves near-instantly. Gating here keeps the data
 * hooks from creating a client before the right provider is chosen. On failure it still renders — the WS
 * safety net in `getTypedApi` covers it.
 */
export function ChainBoot({ children }: { children: ReactNode }) {
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void initChainClient().finally(() => {
      if (!cancelled) setReady(true);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  if (!ready) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-3 text-text-secondary">
        <Spinner className="h-5 w-5" />
        <p className="text-sm">
          {isInHost() ? "Connecting to Polkadot host…" : "Connecting…"}
        </p>
      </div>
    );
  }
  return <>{children}</>;
}
