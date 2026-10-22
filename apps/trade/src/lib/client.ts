// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: © 2026 Parity Technologies
import { createClient, type JsonRpcProvider, type PolkadotClient } from "polkadot-api";
import { getWsProvider } from "polkadot-api/ws";
import { ChainNotSupportedError, getHostChainInfo, getHostProvider } from "@parity/product-sdk-host";
import { ah_paseo_v2, ah_previewnet } from "@polkadot-api/descriptors";
import { activeChain } from "../config/chains";
import { isInHost } from "./host/detect";
import { withTimeout } from "./timeout";
import { UserFacingError } from "./user-errors";

/** The typed API per `.papi` entry; `networks.json` `papiEntry` selects the one for the build's network. */
const TYPED_APIS = {
  ah_previewnet: (client: PolkadotClient) => client.getTypedApi(ah_previewnet),
  ah_paseo_v2: (client: PolkadotClient) => client.getTypedApi(ah_paseo_v2),
};

/** A union, so every call site type-checks against each network's runtime. */
type AssetHubApi = ReturnType<(typeof TYPED_APIS)[keyof typeof TYPED_APIS]>;

/** Hosts without a discovery handler may never answer; discovery is advisory, so don't wait on it. */
const DISCOVERY_TIMEOUT_MS = 5_000;
/** A non-definitive provider failure (bridge not answering yet) gets one retry after this delay. */
const PROVIDER_RETRY_MS = 1_500;
/** Bound on the live genesis check, so a provider that never answers surfaces as an error. */
const VERIFY_TIMEOUT_MS = 20_000;

let rawClient: PolkadotClient | undefined;
let typedApi: AssetHubApi | undefined;
let initPromise: Promise<void> | undefined;

const short = (hash: string) => `${hash.slice(0, 10)}…`;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Initialize the chain client once, choosing the provider by environment:
 * - **Host** (Polkadot Triangle): the host-routed provider for the configured genesis. Contract
 *   addresses are per network, so the genesis is pinned by `networks.json`; host discovery only
 *   *checks* it, turning "the host is on another network" into a clear error. There is **no WS
 *   fallback in host mode**: opening a direct RPC endpoint would bypass the host's chain allowlist.
 * - **Standalone**: a direct WS client.
 * Both modes then verify the live genesis, so a reset chain fails loudly instead of serving reads that
 * point at contracts which no longer exist. Both yield the typed API of the network's descriptors, so
 * all downstream call sites are identical.
 *
 * Concurrency-safe: the in-flight init promise is cached, so overlapping calls (e.g. React StrictMode
 * mounting `ChainBoot` twice) share one initialization and never build two clients. A failed init
 * clears the cache so a later call can retry.
 */
export function initChainClient(): Promise<void> {
  if (typedApi) return Promise.resolve();
  if (!initPromise) {
    initPromise = doInitChainClient().catch((e) => {
      destroyClient();
      throw e;
    });
  }
  return initPromise;
}

async function doInitChainClient(): Promise<void> {
  const provider = isInHost() ? await hostProvider() : getWsProvider(activeChain.wsEndpoint);
  const client = createClient(provider);
  rawClient = client;
  await verifyGenesis(client);
  typedApi = typedApiOf(client);
}

async function hostProvider(attempt = 0): Promise<JsonRpcProvider> {
  const discovery = await withTimeout(
    getHostChainInfo(["AssetHub"]).catch(() => null),
    DISCOVERY_TIMEOUT_MS,
    () => null,
  );
  const served = discovery?.chains.AssetHub;
  if (discovery && served && served.toLowerCase() !== activeChain.genesis.toLowerCase()) {
    throw new UserFacingError(
      `This app is built for ${activeChain.name}, but the Polkadot host is on another network. ` +
        "Open the app published for that network.",
      { cause: `build genesis ${short(activeChain.genesis)}, host serves ${short(served)} on "${discovery.network}"` },
    );
  }
  try {
    const provider = await getHostProvider(activeChain.genesis);
    if (!provider) throw new Error("The Polkadot host is not available.");
    return provider;
  } catch (e) {
    if (e instanceof ChainNotSupportedError) {
      throw new UserFacingError(
        `The Polkadot host does not serve ${activeChain.name}. The network may have been reset, or the host ` +
          "is set up for a different network.",
        { cause: e },
      );
    }
    if (attempt === 0) {
      await sleep(PROVIDER_RETRY_MS);
      return hostProvider(attempt + 1);
    }
    throw e;
  }
}

async function verifyGenesis(client: PolkadotClient): Promise<void> {
  const spec = await withTimeout(client.getChainSpecData(), VERIFY_TIMEOUT_MS, () => {
    throw new UserFacingError(`${activeChain.name} did not answer. Check your connection and reload.`, {
      cause: `no chain spec within ${VERIFY_TIMEOUT_MS / 1000}s`,
    });
  });
  if (spec.genesisHash.toLowerCase() !== activeChain.genesis.toLowerCase()) {
    throw new UserFacingError(
      `${activeChain.name} may have been reset, and this app has not been updated for it yet. Try again later.`,
      { cause: `live genesis ${short(spec.genesisHash)}, build expects ${short(activeChain.genesis)}` },
    );
  }
}

function typedApiOf(client: PolkadotClient): AssetHubApi {
  const entry = activeChain.papiEntry;
  if (!Object.hasOwn(TYPED_APIS, entry)) {
    throw new Error(`No descriptors for papiEntry "${entry}"; add it to TYPED_APIS in lib/client.ts.`);
  }
  return TYPED_APIS[entry as keyof typeof TYPED_APIS](client);
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
    typedApi = typedApiOf(client);
    rawClient = client;
  }
  return typedApi;
}

export function getClient(): PolkadotClient {
  if (!rawClient) getTypedApi();
  return rawClient!;
}

export function destroyClient() {
  rawClient?.destroy();
  rawClient = undefined;
  typedApi = undefined;
  initPromise = undefined;
}
