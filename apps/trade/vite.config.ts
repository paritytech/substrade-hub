// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: © 2026 Parity Technologies
import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * Fail fast when the selected network and its PAPI descriptor disagree: a genesis mismatch means the
 * chain was reset (or the wrong `.papi` entry is referenced), and the app would otherwise build fine and
 * break at runtime. The full field validation happens in `src/config/chains.ts`.
 */
function assertNetworkMatchesDescriptor(network: string | undefined) {
  const read = (file: string) => JSON.parse(readFileSync(path.resolve(__dirname, file), "utf8"));
  const networks = read("src/config/networks.json") as Record<string, { genesis: string; papiEntry: string }>;
  const papi = read(".papi/polkadot-api.json") as { entries: Record<string, { genesis?: string }> };

  if (!network) throw new Error(`VITE_NETWORK is not set; expected one of: ${Object.keys(networks).join(", ")}`);
  const cfg = networks[network];
  if (!cfg) throw new Error(`VITE_NETWORK "${network}" is not in src/config/networks.json`);
  const entry = papi.entries[cfg.papiEntry];
  if (!entry) throw new Error(`networks.json "${network}": papiEntry "${cfg.papiEntry}" is not in .papi/polkadot-api.json`);
  if (entry.genesis?.toLowerCase() !== cfg.genesis.toLowerCase()) {
    throw new Error(
      `networks.json "${network}" genesis ${cfg.genesis} differs from .papi entry "${cfg.papiEntry}" ` +
        `(${entry.genesis}). If the chain was reset, update both and regenerate the descriptors.`,
    );
  }
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, __dirname, "VITE_");
  assertNetworkMatchesDescriptor(process.env.VITE_NETWORK ?? env.VITE_NETWORK);
  return {
    // Relative base so the build serves correctly from IPFS / Bulletin gateways when deployed as a
    // Polkadot Triangle (.dot) app; harmless for standalone hosting.
    base: "./",
    plugins: [react(), tailwindcss()],
    resolve: {
      alias: {
        "@": path.resolve(__dirname, "src"),
      },
    },
  };
});
