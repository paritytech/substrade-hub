import { navigateTo } from "@parity/product-sdk-host";
import { isInHost } from "./detect";

/**
 * Open `href` outside the app. Inside a host, the host navigates (an `https://` URL opens in the
 * system browser, a `.dot` link in the host); if it refuses or fails, a new window is tried. Returns
 * false when the caller should let the browser follow the link itself (outside a host).
 */
export function openExternal(href: string): boolean {
  if (!isInHost()) return false;
  void navigateTo(href).then(
    (result) => {
      if (!result.ok) fallback(href, result.error);
    },
    (e: unknown) => fallback(href, e),
  );
  return true;
}

function fallback(href: string, reason: unknown): void {
  console.warn(`[navigate] the host did not open ${href}; trying a new window`, reason);
  window.open(href, "_blank", "noopener,noreferrer");
}
