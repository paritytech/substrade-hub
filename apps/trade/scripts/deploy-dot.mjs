// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: © 2026 Parity Technologies
/**
 * Publish the built app to the network named by VITE_NETWORK: uploads `dist/` to that network's Bulletin
 * chain and points its dotNS name at it, registering the name first when it is free. The name and the
 * bulletin-deploy environment come from src/config/networks.json, the manifest from
 * bulletin-deploy.config.ts. Used by .github/workflows/deploy-dot.yml and for local deploys.
 *
 * Usage (from apps/trade, after `VITE_NETWORK=<name> pnpm build`):
 *   VITE_NETWORK=previewnet APP_VERSION=1.2.3 MNEMONIC="<owner mnemonic>" pnpm deploy:dot
 *
 * MNEMONIC is the dotNS owner key, read by bulletin-deploy from the environment so it never appears in
 * the process arguments. When DOTNS_OWNER (the owner's SS58 address) is set, the script refuses to
 * publish unless MNEMONIC derives that account, which catches a wrong or garbled secret before any
 * chain write.
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { getSs58AddressInfo } from "polkadot-api";
import { sr25519CreateDerive } from "@polkadot-labs/hdkd";
import { entropyToMiniSecret, mnemonicToEntropy, validateMnemonic } from "@polkadot-labs/hdkd-helpers";

// bulletin-deploy handles the owner mnemonic, so the code that runs must be reviewed: it is an
// exact-version devDependency, installed from the lockfile with integrity hashes and without install
// scripts (see pnpm-workspace.yaml). Bump it deliberately.
const BULLETIN_DEPLOY = fileURLToPath(new URL("../node_modules/.bin/bulletin-deploy", import.meta.url));

/**
 * The environment bulletin-deploy runs with: what it needs, and nothing else from this process. Of the
 * runner's variables it gets GITHUB_OUTPUT, where it writes the CID, and the read-only run metadata it
 * reports; never a token, and never the files that change later steps' environment (GITHUB_ENV,
 * GITHUB_PATH).
 */
function bulletinDeployEnv() {
  const names = [
    "PATH", "HOME", "TMPDIR", "LANG", "LC_ALL", "TERM", "CI", "DO_NOT_TRACK",
    "MNEMONIC", "VITE_NETWORK", "APP_VERSION", "DOTNS_RPC",
    "GITHUB_OUTPUT", "GITHUB_ACTIONS", "GITHUB_REPOSITORY", "GITHUB_SERVER_URL", "GITHUB_RUN_ID",
    "GITHUB_RUN_ATTEMPT", "GITHUB_WORKFLOW", "GITHUB_JOB", "GITHUB_SHA", "GITHUB_REF_NAME", "GITHUB_HEAD_REF",
  ];
  const keep = (name) => names.includes(name) || /^(BULLETIN_|RUNNER_|XDG_)/.test(name);
  return Object.fromEntries(Object.entries(process.env).filter(([name]) => keep(name)));
}

const networks = JSON.parse(readFileSync(new URL("../src/config/networks.json", import.meta.url), "utf8"));
const name = process.env.VITE_NETWORK;
const network = networks[name];
if (!network) {
  console.error(`Set VITE_NETWORK to one of: ${Object.keys(networks).join(", ")}`);
  process.exit(1);
}
if (/^0x0{40}$/i.test(network.factoryAddress)) {
  console.error(`${name} has no contracts yet; run contracts/scripts/bootstrap.mjs --network ${name} first`);
  process.exit(1);
}
for (const key of ["MNEMONIC", "APP_VERSION"]) {
  if (!process.env[key]) {
    console.error(`${key} is not set`);
    process.exit(1);
  }
}

const owner = process.env.DOTNS_OWNER?.trim();
if (owner) {
  const info = getSs58AddressInfo(owner);
  if (!info.isValid) {
    console.error(`DOTNS_OWNER "${owner}" is not a valid SS58 address`);
    process.exit(1);
  }
  const mnemonic = process.env.MNEMONIC.trim();
  if (!validateMnemonic(mnemonic)) {
    console.error("MNEMONIC is not a valid BIP39 mnemonic");
    process.exit(1);
  }
  // bulletin-deploy signs with the root sr25519 key of the mnemonic (no derivation path).
  const derived = sr25519CreateDerive(entropyToMiniSecret(mnemonicToEntropy(mnemonic)))("").publicKey;
  if (Buffer.compare(Buffer.from(derived), Buffer.from(info.publicKey)) !== 0) {
    console.error(`MNEMONIC does not derive DOTNS_OWNER ${owner}; refusing to publish`);
    process.exit(1);
  }
  console.log(`Owner check passed: MNEMONIC derives ${owner}`);
}

const args = [
  "--env",
  network.bulletinDeployEnv,
  "--js-merkle",
  "--config",
  "bulletin-deploy.config.ts",
  "./dist",
  network.dotnsName,
];
console.log(`Publishing ${network.dotnsName} to ${network.name} (bulletin-deploy --env ${network.bulletinDeployEnv})`);
const run = spawnSync(BULLETIN_DEPLOY, args, {
  stdio: "inherit",
  cwd: new URL("..", import.meta.url),
  env: bulletinDeployEnv(),
});
process.exit(run.status ?? 1);
