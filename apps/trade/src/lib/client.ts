import { createClient, type TypedApi } from "polkadot-api";
import { getWsProvider } from "polkadot-api/ws";
import { passet_hub } from "@polkadot-api/descriptors";
import { activeChain } from "../config/chains";

type PaseoAssetHubApi = TypedApi<typeof passet_hub>;

let client: ReturnType<typeof createClient> | undefined;
let typedApi: PaseoAssetHubApi | undefined;

export function getTypedApi(): PaseoAssetHubApi {
  if (!typedApi) {
    client = createClient(getWsProvider(activeChain.wsEndpoint));
    typedApi = client.getTypedApi(passet_hub);
  }
  return typedApi;
}

export function getClient() {
  if (!client) getTypedApi();
  return client!;
}

export function destroyClient() {
  client?.destroy();
  client = undefined;
  typedApi = undefined;
}
