/**
 * Demo host harness: wrap the running dev server in a real Polkadot Triangle host (via
 * @parity/host-api-test-sdk) so the app can be tried "inside a host" in any browser tab — no Polkadot
 * Desktop install, no deploy.
 *
 * Usage (two terminals):
 *   VITE_NETWORK=previewnet pnpm dev         # starts Vite on http://localhost:5173
 *   VITE_NETWORK=previewnet pnpm demo:host   # prints a URL — open it in your browser
 *
 * The test host serves the Asset Hub of the network named by VITE_NETWORK (same as the dev server), from
 * src/config/networks.json, so the real order book renders. The product's key subtree is //Alice; the
 * account the app signs with is derived from it (a soft child, a different address from Alice), so fund
 * that account from Alice before trading.
 */
import { readFileSync } from "node:fs";
import { createTestHostServer } from "@parity/host-api-test-sdk";

const networks = JSON.parse(readFileSync(new URL("../src/config/networks.json", import.meta.url), "utf8"));
const networkName = process.env.VITE_NETWORK;
const network = networks[networkName];
if (!network) {
  console.error(`Set VITE_NETWORK to one of: ${Object.keys(networks).join(", ")}`);
  process.exit(1);
}

const PRODUCT_URL = process.env.PRODUCT_URL ?? "http://localhost:5173";
const PORT = Number(process.env.HOST_PORT ?? 5180);

const server = await createTestHostServer({
  productUrl: PRODUCT_URL,
  // Run as our dotNS name: the host refuses product-account signing for any other product id.
  productId: network.dotnsName,
  accounts: ["alice"],
  // Root the product's account subtree, keyed by its bare dotNS name, at //Alice.
  productAccounts: { [network.dotnsName]: "alice" },
  networks: [
    {
      id: networkName,
      name: network.name,
      genesisHash: network.genesis,
      rpcUrl: network.wsEndpoint,
      tokenSymbol: "PAS",
      tokenDecimals: 10,
      // Answer host chain discovery for Asset Hub, as a real host does.
      chain: "AssetHub",
    },
  ],
  port: PORT,
});

console.log(`\n  Demo host running: ${server.url}`);
console.log(`  (embedding ${PRODUCT_URL} — make sure \`pnpm dev\` is running)\n`);

const shutdown = () => {
  void server.close().finally(() => process.exit(0));
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
