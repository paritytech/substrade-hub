/**
 * The app's URL, kept in the hash so the static bundle needs no server routes (dot.li gateways and
 * IPFS serve one `index.html`):
 *   `#/` (or none)        Home
 *   `#/market/<address>`  Trade, on that market
 *   `#/orders`            Trade, with the Open Orders panel in view
 * A `#/market/…` that is not a full address is Trade with `brokenLink` set, so the app can say so.
 */
export type Route =
  | { view: "home" }
  | { view: "trade"; market?: `0x${string}`; focus?: "orders"; brokenLink?: true };

const MARKET = /^market\/(0x[0-9a-fA-F]{40})$/;

/** The route a location hash names; anything unrecognised is Home. */
export function parseRoute(hash: string): Route {
  const path = hash.replace(/^#\/?/, "").replace(/\/$/, "");
  if (path === "orders") return { view: "trade", focus: "orders" };
  const market = path.match(MARKET)?.[1];
  if (market) return { view: "trade", market: market as `0x${string}` };
  if (path === "market" || path.startsWith("market/")) return { view: "trade", brokenLink: true };
  return { view: "home" };
}

/** The hash for the app's state, or null for Trade before a market is selected. */
export function routeHash(view: "home" | "trade", market: `0x${string}` | undefined): string | null {
  if (view === "home") return "#/";
  return market ? `#/market/${market}` : null;
}

/** Whether `hash` already names this state, so it need not be written again. */
export function hashMatches(hash: string, view: "home" | "trade", market: `0x${string}` | undefined): boolean {
  const route = parseRoute(hash);
  if (route.view !== view) return false;
  if (route.view === "home") return true;
  return route.market !== undefined && market !== undefined && route.market.toLowerCase() === market.toLowerCase();
}

/**
 * The market to select for `route` among `markets`: the linked one, else the one already selected,
 * else the first. `notListed` is set when the route links a market these markets do not include.
 */
export function resolveMarket<M extends { address: `0x${string}` }>(
  route: Route,
  markets: readonly M[],
  selected: M | null,
): { market: M | undefined; notListed: boolean } {
  const wanted = route.view === "trade" ? route.market : undefined;
  const linked = wanted && markets.find((m) => m.address.toLowerCase() === wanted.toLowerCase());
  if (linked) return { market: linked, notListed: false };
  return { market: selected ?? markets[0], notListed: wanted !== undefined };
}
