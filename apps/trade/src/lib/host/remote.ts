/**
 * Outbound network access inside a Polkadot host.
 *
 * Hosts sandbox a product's HTTP traffic: the Android host, for one, answers 403 Forbidden to any
 * request whose domain is outside the product's own dotNS name unless the product holds a `Remote`
 * permission for that domain (RFC 0002: "outbound HTTP/WebSocket access to a set of domains"). Chain
 * reads and writes go through the host's chain connection and need no such grant; the one direct HTTP
 * call this app makes inside a host is trade history, which reads `eth_getLogs` from the network's
 * eth-rpc (see `use-trade-history`). Requesting the grant up front lets the user approve it once, before
 * the chart needs it.
 *
 * Best-effort: a denied or failed request leaves the chart on its on-chain fallback (recent blocks
 * only), and never blocks the rest of the app.
 */
import { requestPermission } from "@parity/product-sdk-host";
import { activeChain } from "../../config/chains";

/** The domains this app calls directly over HTTP: the network's eth-rpc. */
export function remoteDomains(): string[] {
  return [new URL(activeChain.rpcUrl).hostname];
}

let requested: Promise<boolean> | undefined;

/** Ask the host for the `Remote` grant once per session. Resolves to whether it was granted. */
export function requestRemoteAccess(): Promise<boolean> {
  requested ??= requestPermission({ tag: "Remote", value: { domains: remoteDomains() } })
    .then((r) => {
      if (!r.ok) {
        console.warn("[host] network access request failed; trade history falls back to recent blocks:", r.error);
        return false;
      }
      if (!r.value) console.warn("[host] network access denied; trade history falls back to recent blocks");
      return r.value;
    })
    .catch((e: unknown) => {
      console.warn("[host] network access request failed; trade history falls back to recent blocks:", e);
      return false;
    });
  return requested;
}
