import { defineConfig } from "vitest/config";

// Dedicated config so unit tests do not load the app's vite plugins (react/tailwind).
// Pure-logic tests run in the node environment.
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts", "scripts/**/*.test.mjs"],
    // `config/chains` resolves the network at import time; tests run against previewnet's entry.
    env: { VITE_NETWORK: "previewnet" },
  },
});
