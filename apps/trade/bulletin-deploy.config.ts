// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: © 2026 Parity Technologies
// Product manifest for `bulletin-deploy` (run through scripts/deploy-dot.mjs). It publishes the built
// `dist/` to the Bulletin chain and points the network's dotNS name (networks.json `dotnsName`) at it.
// See docs/deploy.md.
import networks from "./src/config/networks.json";

function network(): { dotnsName: string } {
  const name = process.env.VITE_NETWORK;
  const entry = name ? (networks as Record<string, { dotnsName: string }>)[name] : undefined;
  if (!entry) throw new Error(`VITE_NETWORK must name a network in src/config/networks.json (got "${name}")`);
  return entry;
}

// The published app version comes from the release, never hardcoded, so successive `dot-v*` tags do
// not all publish as the same version. APP_VERSION is REQUIRED (the deploy workflow sets it from the tag
// or the workflow_dispatch input; a local deploy must export it). The strict regex rejects malformed
// input like "1..2" that a naive split+Number would silently coerce (Number("") === 0).
function appVersion(): [number, number, number] {
  const raw = process.env.APP_VERSION;
  if (!raw) {
    throw new Error("APP_VERSION is required (MAJOR.MINOR.PATCH); set it from the release before publishing.");
  }
  if (!/^\d+\.\d+\.\d+$/.test(raw)) {
    throw new Error(`Invalid APP_VERSION "${raw}"; expected MAJOR.MINOR.PATCH`);
  }
  return raw.split(".").map(Number) as [number, number, number];
}

export default {
  domain: network().dotnsName,
  displayName: "SubsTrade Hub",
  description: "Fully on-chain order-book DEX on Asset Hub.",
  icon: { path: "./icon.png", format: "png" },
  executables: [{ kind: "app", path: "./dist", appVersion: appVersion() }],
};
