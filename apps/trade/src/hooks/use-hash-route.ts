import { useEffect, useRef, useState } from "react";
import { useMarkets } from "./use-markets";
import { useMarketStore } from "../stores/market";
import { useViewStore } from "../stores/view";
import { useToastStore } from "../stores/toast";
import { activeChain } from "../config/chains";
import { hashMatches, parseRoute, resolveMarket, routeHash, type Route } from "../lib/route";

/**
 * Keep the view and the selected market in the URL hash (see `lib/route`). The hash is read at start
 * and on back/forward; navigating writes it back as a new history entry, so Back returns to the
 * previous market or view. A linked market is selected once the markets load; one this network does
 * not list, or a link cut short, falls back to the first market, with a toast. Also selects the first market when nothing
 * names one.
 */
export function useHashRoute(): void {
  const { data: markets } = useMarkets();
  const [route, setRoute] = useState<Route>(() => parseRoute(window.location.hash));
  // Until the route's market is resolved, the state does not yet reflect the hash: do not write it.
  const resolved = useRef(false);

  useEffect(() => {
    const apply = () => {
      const next = parseRoute(window.location.hash);
      resolved.current = false;
      setRoute(next);
    };
    window.addEventListener("hashchange", apply);
    window.addEventListener("popstate", apply);
    return () => {
      window.removeEventListener("hashchange", apply);
      window.removeEventListener("popstate", apply);
    };
  }, []);

  // Show the route's view at once; its market waits for the markets.
  useEffect(() => {
    const view = useViewStore.getState();
    view.setView(route.view);
    if (route.view === "trade" && route.focus) view.setFocus(route.focus);
  }, [route]);

  // Resolve the route once: the markets refetch, and a later refetch must not undo the user's choice.
  useEffect(() => {
    if (resolved.current || !markets?.length) return;

    const { selectedMarket, selectMarket } = useMarketStore.getState();
    const { market, notListed } = resolveMarket(route, markets, selectedMarket);
    if (notListed || (route.view === "trade" && route.brokenLink)) {
      const what = notListed ? `The linked market is not listed on ${activeChain.name}` : "This link to a market is incomplete";
      useToastStore.getState().addToast("error", `${what}. Showing another market instead.`);
    }
    if (market && market !== selectedMarket) selectMarket(market);
    resolved.current = true;
    write(true);
  }, [route, markets]);

  useEffect(() => {
    const unsubView = useViewStore.subscribe((s, prev) => s.view !== prev.view && write(false));
    const unsubMarket = useMarketStore.subscribe((s, prev) => s.selectedMarket !== prev.selectedMarket && write(false));
    return () => {
      unsubView();
      unsubMarket();
    };
  }, []);

  /**
   * Write the state into the hash when it differs. `normalise` replaces the current entry (a link
   * resolved to its market, or `#/orders` to the market shown); otherwise it is a navigation.
   */
  function write(normalise: boolean) {
    if (!resolved.current) return;
    const { view } = useViewStore.getState();
    const market = useMarketStore.getState().selectedMarket?.address;
    if (hashMatches(window.location.hash, view, market)) return;
    const hash = routeHash(view, market);
    if (!hash) return;
    if (normalise) window.history.replaceState(null, "", hash);
    else window.history.pushState(null, "", hash);
  }
}
