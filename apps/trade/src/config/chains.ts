export const chains = {
  paseoAssetHub: {
    name: "Paseo Asset Hub",
    wsEndpoint: "wss://asset-hub-paseo-rpc.n.dwellir.com",
    rpcUrl: "https://eth-rpc-testnet.polkadot.io",
    chainId: 420420417,
    factoryAddress: "0xc3390f794e5fbf89424e220f98766f6383ddf46d" as `0x${string}`,
    explorerUrl: "https://assethub-paseo.subscan.io",
  },
} as const;

export const activeChain = chains.paseoAssetHub;
