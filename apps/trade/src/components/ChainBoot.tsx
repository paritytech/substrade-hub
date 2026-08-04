import { useEffect, useState, type ReactNode } from "react";
import { initChainClient } from "../lib/client";
import { isInHost } from "../lib/host/detect";
import { Spinner } from "./ui/Spinner";

/**
 * Gate rendering on the chain client being initialized. In a Polkadot host this awaits host detection
 * and picks the host-routed provider; standalone it resolves near-instantly. Gating here keeps the data
 * hooks from creating a client before the right provider is chosen.
 *
 * On failure it renders a fatal state and does NOT render children. In host mode a failed init means the
 * host does not serve this chain (or the host client is unavailable); rendering children anyway would let
 * `getTypedApi` open a direct WS and bypass the host's chain allowlist, so the app must stop here.
 */
export function ChainBoot({ children }: { children: ReactNode }) {
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = useState<string>();

  useEffect(() => {
    let cancelled = false;
    initChainClient().then(
      () => {
        if (!cancelled) setState("ready");
      },
      (e: unknown) => {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : String(e));
        setState("error");
      },
    );
    return () => {
      cancelled = true;
    };
  }, []);

  if (state === "loading") {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-3 text-text-secondary">
        <Spinner className="h-5 w-5" />
        <p className="text-sm">{isInHost() ? "Connecting to Polkadot host…" : "Connecting…"}</p>
      </div>
    );
  }

  if (state === "error") {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-3 px-6 text-center">
        <p className="text-base font-medium text-text-primary">Chain unavailable</p>
        <p className="max-w-md text-sm text-text-secondary">
          {isInHost()
            ? "This Polkadot host does not serve the chain this app runs on. Open it from a host that supports Asset Hub, or run it standalone in a browser."
            : "Could not connect to the chain."}
        </p>
        {error && <p className="max-w-md text-xs text-text-muted">{error}</p>}
      </div>
    );
  }

  return <>{children}</>;
}
