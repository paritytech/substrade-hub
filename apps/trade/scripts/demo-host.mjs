/**
 * Demo host harness: wrap the running dev server in a real Polkadot Triangle host (via
 * @parity/host-api-test-sdk) so the app can be tried "inside a host" in any browser tab — no Polkadot
 * Desktop install, no deploy. Alice is a funded dev account mapped to this product's account.
 *
 * Usage (two terminals):
 *   pnpm dev            # starts Vite on http://localhost:5173
 *   pnpm demo:host      # prints a URL — open it in your browser
 *
 * The test host is configured to serve OUR chain (Paseo Asset Hub) so the real order book renders. Note
 * the account has no tUSD/tNVDA, so trading isn't exercised here — this only needs chain reads to render.
 */
import { createTestHostServer } from "@parity/host-api-test-sdk";

const PRODUCT_URL = process.env.PRODUCT_URL ?? "http://localhost:5173";
const PORT = Number(process.env.HOST_PORT ?? 5180);

const server = await createTestHostServer({
  productUrl: PRODUCT_URL,
  accounts: ["alice"],
  // Product-account derivation key -> funded dev account. "substrade-hub.dot" is our .dot domain.
  productAccounts: { "substrade-hub.dot/0": "alice" },
  // Serve our chain so reads hit the real DLOB. genesis/rpc match config/chains.ts (Paseo Asset Hub).
  networks: [
    {
      id: "paseo-asset-hub",
      name: "Paseo Asset Hub",
      genesisHash: "0xd6eec26135305a8ad257a20d003357284c8aa03d0bdb2b357ab0a22371e11ef2",
      rpcUrl: "wss://asset-hub-paseo-rpc.n.dwellir.com",
      tokenSymbol: "PAS",
      tokenDecimals: 10,
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
