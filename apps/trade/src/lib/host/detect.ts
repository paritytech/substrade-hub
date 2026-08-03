/**
 * Detect whether the app is running inside a Polkadot Triangle host (Polkadot Desktop webview, dot.li /
 * dev-dot.li iframe, or the `@parity/host-api-test-sdk` harness) vs a plain browser tab. Uses the
 * official `@parity/product-sdk-host` container check; `VITE_USE_HOST_API=false` forces standalone
 * (useful for local dev / e2e in a plain tab).
 */
import { isInsideContainerSync } from "@parity/product-sdk-host";

export function isInHost(): boolean {
  if (typeof window === "undefined") return false;
  if (import.meta.env.VITE_USE_HOST_API === "false") return false;
  try {
    return isInsideContainerSync();
  } catch {
    return false;
  }
}
