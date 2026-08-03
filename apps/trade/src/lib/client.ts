import { createClient, type TypedApi, type PolkadotClient } from "polkadot-api";
import { getWsProvider } from "polkadot-api/ws";
import { createChainClient } from "@parity/product-sdk-chain-client";
import { isChainSupported } from "@parity/product-sdk-host";
import { passet_hub } from "@polkadot-api/descriptors";
import { activeChain } from "../config/chains";
import { isInHost } from "./host/detect";

type PaseoAssetHubApi = TypedApi<typeof passet_hub>;

let rawClient: PolkadotClient | undefined;
let typedApi: PaseoAssetHubApi | undefined;
let teardown: (() => void) | undefined;

/**
 * Initialize the chain client once, choosing the client by environment:
 * - **Host** (Polkadot Triangle): the sanctioned host-routed `createChainClient` — no RPC endpoint, the
 *   descriptor's genesis selects the chain. Gated by `isChainSupported` so an unsupported chain fails
 *   fast instead of hanging; falls back to WS if the host client is unavailable.
 * - **Standalone**: a direct WS client.
 * Both yield a `TypedApi<passet_hub>`, so all downstream call sites are identical. Async because the
 * host path awaits the container; call once at boot before the data hooks fire (see `ChainBoot`).
 */
export async function initChainClient(): Promise<void> {
  if (typedApi) return;
  if (isInHost()) {
    try {
      const supported = await isChainSupported(activeChain.genesis);
      if (supported.ok && supported.value === false) {
        throw new Error(`host does not serve ${activeChain.name} (genesis ${activeChain.genesis})`);
      }
      const cc = await createChainClient({ chains: { assetHub: passet_hub } });
      typedApi = cc.assetHub;
      rawClient = cc.raw.assetHub;
      teardown = cc.destroy;
      return;
    } catch (e) {
      console.warn("[chain] host-routed client unavailable, falling back to WS:", e);
    }
  }
  const client = createClient(getWsProvider(activeChain.wsEndpoint));
  typedApi = client.getTypedApi(passet_hub);
  rawClient = client;
  teardown = () => client.destroy();
}

export function getTypedApi(): PaseoAssetHubApi {
  if (!typedApi) {
    // Safety net for a caller that reaches the client before initChainClient() ran (standalone WS).
    // Host mode is gated on init at boot, so this path only fires standalone or in unit tests.
    const client = createClient(getWsProvider(activeChain.wsEndpoint));
    typedApi = client.getTypedApi(passet_hub);
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
}
