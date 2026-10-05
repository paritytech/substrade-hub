import { createClient, type TypedApi, type PolkadotClient } from "polkadot-api";
import { getWsProvider } from "polkadot-api/ws";
import { createChainClient } from "@parity/product-sdk-chain-client";
import { isChainSupported } from "@parity/product-sdk-host";
import { ah_previewnet } from "@polkadot-api/descriptors";
import { activeChain } from "../config/chains";
import { isInHost } from "./host/detect";

type AssetHubApi = TypedApi<typeof ah_previewnet>;

let rawClient: PolkadotClient | undefined;
let typedApi: AssetHubApi | undefined;
let teardown: (() => void) | undefined;
let initPromise: Promise<void> | undefined;

/**
 * Initialize the chain client once, choosing the client by environment:
 * - **Host** (Polkadot Triangle): the sanctioned host-routed `createChainClient` — no RPC endpoint, the
 *   descriptor's genesis selects the chain. Gated by `isChainSupported`. There is **no WS fallback in
 *   host mode**: opening a direct RPC endpoint would bypass the host's chain allowlist, so an
 *   unsupported chain, a failed support check, or an unavailable host client is a **fatal** condition
 *   that rejects (surfaced by `ChainBoot`), never silently worked around.
 * - **Standalone**: a direct WS client.
 * Both yield a `TypedApi<ah_previewnet>`, so all downstream call sites are identical.
 *
 * Concurrency-safe: the in-flight init promise is cached, so overlapping calls (e.g. React StrictMode
 * mounting `ChainBoot` twice) share one initialization and never build two clients. A failed init
 * clears the cache so a later call can retry.
 */
export function initChainClient(): Promise<void> {
  if (typedApi) return Promise.resolve();
  if (!initPromise) {
    initPromise = doInitChainClient().catch((e) => {
      initPromise = undefined;
      throw e;
    });
  }
  return initPromise;
}

async function doInitChainClient(): Promise<void> {
  if (isInHost()) {
    // Fail fast (no WS fallback): a direct RPC endpoint in a host bypasses the chain allowlist.
    const supported = await isChainSupported(activeChain.genesis);
    if (!supported.ok) {
      const reason = (supported.error as { message?: string } | undefined)?.message ?? "unknown error";
      throw new Error(`could not verify host support for ${activeChain.name}: ${reason}`);
    }
    if (!supported.value) {
      throw new Error(`host does not serve ${activeChain.name} (genesis ${activeChain.genesis})`);
    }
    const cc = await createChainClient({ chains: { assetHub: ah_previewnet } });
    typedApi = cc.assetHub;
    rawClient = cc.raw.assetHub;
    teardown = cc.destroy;
    return;
  }
  const client = createClient(getWsProvider(activeChain.wsEndpoint));
  typedApi = client.getTypedApi(ah_previewnet);
  rawClient = client;
  teardown = () => client.destroy();
}

export function getTypedApi(): AssetHubApi {
  if (!typedApi) {
    // In host mode we must never open a direct WS: that is the very policy bypass the host gate exists
    // to prevent. If typedApi is unset here, host init failed or never ran, so this is a hard error.
    // ChainBoot gates data hooks behind a successful init, so this only fires standalone or in tests.
    if (isInHost()) {
      throw new Error("chain client is not initialized: the host chain is unavailable");
    }
    const client = createClient(getWsProvider(activeChain.wsEndpoint));
    typedApi = client.getTypedApi(ah_previewnet);
    rawClient = client;
    teardown = () => client.destroy();
  }
  return typedApi;
}

export function getClient(): PolkadotClient {
  if (!rawClient) getTypedApi();
  return rawClient!;
}

export function destroyClient() {
  teardown?.();
  rawClient = undefined;
  typedApi = undefined;
  teardown = undefined;
  initPromise = undefined;
}
