/**
 * Chain configuration. Structured as a `ChainConfig` per network so host mode (Polkadot Triangle) can
 * later target a different chain than standalone without touching call sites. Today both modes use Paseo
 * Asset Hub (where the DLOB contracts are deployed); host mode reuses this config and routes reads
 * through the host bridge with a WS fallback (see lib/client). When the contracts are redeployed on the
 * host's canonical chain (`next-asset-hub-paseo`, genesis 0xbf0488…), add a second `ChainConfig` and
 * select it by mode.
 */
export interface ChainConfig {
  name: string;
  /** Genesis hash — used by the host provider (`createPapiProvider`) to route/identify the chain. */
  genesis: `0x${string}`;
  wsEndpoint: string;
  rpcUrl: string;
  chainId: number;
  factoryAddress: `0x${string}`;
  explorerUrl: string;
}

export const chains = {
  paseoAssetHub: {
    name: "Paseo Asset Hub",
    genesis: "0xd6eec26135305a8ad257a20d003357284c8aa03d0bdb2b357ab0a22371e11ef2",
    wsEndpoint: "wss://asset-hub-paseo-rpc.n.dwellir.com",
    rpcUrl: "https://eth-rpc-testnet.polkadot.io",
    chainId: 420420417,
    factoryAddress: "0xc3390f794e5fbf89424e220f98766f6383ddf46d",
    explorerUrl: "https://assethub-paseo.subscan.io",
  },
} as const satisfies Record<string, ChainConfig>;

export const activeChain: ChainConfig = chains.paseoAssetHub;
