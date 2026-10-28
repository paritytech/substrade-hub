// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: © 2026 Parity Technologies
/**
 * Check the chain against a release: each network's dotNS name must point at the release's CID, its
 * contracts must match the release's deployments.json (same factory, faucet, quote and markets, each
 * with code), and the code they run must be the release's build (codehashes.json: the implementation,
 * factory, libraries and faucet by masked codehash, every market a minimal proxy to the implementation).
 * Exits non-zero on any mismatch.
 *
 * The release's files only state what the chain should hold. Where to read the chain (each network's
 * eth-rpc URL, content resolver and dotNS name) comes from `networks.json` in the repository: at the
 * release's tag with `--tag`, otherwise the checked-out file or `--networks`. A release manifest that
 * names another endpoint, resolver or name fails the check.
 *
 * Usage (from the repo root, after `pnpm install`):
 *   node apps/trade/scripts/release/verify.mjs --tag dot-v1.2.3
 *   node apps/trade/scripts/release/verify.mjs --manifest <file> --deployments <file> --codehashes <file> [--networks <file>]
 * `--tag` downloads the three assets, and `networks.json` at the tag, with the GitHub CLI (`gh`).
 *
 * A later release moves the names to a newer build, so an older release then reports a CID mismatch
 * on purpose: the check answers "is this release what the chain serves now".
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { readDeployment, readPublishedCid } from "./lib.mjs";
import { checkLiveCode } from "./codehash.mjs";

const NETWORKS_PATH = "apps/trade/src/config/networks.json";

/** The fields that say where to read a network: they come from `networks.json`, never from the release. */
const LOCATION_FIELDS = ["dotnsName", "rpcUrl", "dotnsContentResolver"];

/**
 * The network to read for manifest entry `id`: its location from `networks.json` (`source`), the
 * release's recorded contracts from `recorded`. Also returns where the manifest names another location.
 */
export function networkToVerify(id, entry, recorded, source) {
  const trusted = source[id];
  if (!trusted) throw new Error(`networks.json has no network ${id}`);
  const problems = LOCATION_FIELDS.filter((k) => entry[k] !== trusted[k]).map(
    (k) => `the release manifest gives ${k} ${entry[k]}, networks.json gives ${trusted[k]}`,
  );
  const net = {
    name: trusted.name,
    dotnsName: trusted.dotnsName,
    rpcUrl: trusted.rpcUrl,
    dotnsContentResolver: trusted.dotnsContentResolver,
    chainId: recorded.chainId,
    genesis: recorded.genesis,
    factoryAddress: recorded.factory,
    faucetAddress: recorded.faucet,
    knownQuote: { addr: recorded.quote },
  };
  return { net, problems };
}

/** Mismatches between a release's deployment record and the deployment read from the chain. */
export function diffDeployment(recorded, live) {
  const problems = [];
  for (const key of ["factory", "faucet", "quote"]) {
    if (recorded[key] !== live[key]) problems.push(`${key} is ${live[key]}, the release records ${recorded[key]}`);
  }
  if (JSON.stringify(recorded.markets) !== JSON.stringify(live.markets)) {
    const list = (markets) => markets.map((m) => m.address).join(", ") || "none";
    problems.push(`markets are ${list(live.markets)}, the release records ${list(recorded.markets)}`);
  }
  return problems;
}

async function main() {
  const { values } = parseArgs({
    options: {
      tag: { type: "string" },
      manifest: { type: "string" },
      deployments: { type: "string" },
      codehashes: { type: "string" },
      networks: { type: "string" },
      repo: { type: "string", default: "paritytech/substrade-hub" },
    },
  });
  let { manifest: manifestFile, deployments: deploymentsFile, codehashes: codehashesFile } = values;
  let networksFile = values.networks ?? NETWORKS_PATH;
  if (values.tag) {
    const dir = mkdtempSync(join(tmpdir(), "substrade-release-"));
    execFileSync(
      "gh",
      ["release", "download", values.tag, "--repo", values.repo, "-D", dir, "-p", "release-manifest.json", "-p", "deployments.json"],
      { stdio: "inherit" },
    );
    manifestFile = join(dir, "release-manifest.json");
    deploymentsFile = join(dir, "deployments.json");
    // Releases before codehashes.json existed have none; their code is then not checked.
    try {
      execFileSync("gh", ["release", "download", values.tag, "--repo", values.repo, "-D", dir, "-p", "codehashes.json"], {
        stdio: "ignore",
      });
      codehashesFile = join(dir, "codehashes.json");
    } catch {
      console.log(`${values.tag} has no codehashes.json: the contracts' code is not checked`);
    }
    if (!values.networks) {
      networksFile = join(dir, "networks.json");
      const source = execFileSync("gh", [
        "api",
        "-H",
        "Accept: application/vnd.github.raw",
        `repos/${values.repo}/contents/${NETWORKS_PATH}?ref=${encodeURIComponent(values.tag)}`,
      ]);
      writeFileSync(networksFile, source);
    }
  }
  if (!manifestFile || !deploymentsFile) throw new Error("Pass --tag, or --manifest and --deployments (and --codehashes)");
  const manifest = JSON.parse(readFileSync(manifestFile, "utf8"));
  const deployments = JSON.parse(readFileSync(deploymentsFile, "utf8"));
  const codehashes = codehashesFile ? JSON.parse(readFileSync(codehashesFile, "utf8")) : null;
  const source = JSON.parse(readFileSync(networksFile, "utf8"));
  if (values.tag && manifest.tag !== values.tag) {
    throw new Error(`the release manifest of ${values.tag} names tag ${manifest.tag}`);
  }

  console.log(`Verifying ${manifest.tag} (commit ${manifest.commit})`);
  let failed = false;
  for (const [id, entry] of Object.entries(manifest.networks)) {
    const recorded = deployments[id];
    if (!recorded) throw new Error(`deployments.json has no entry for ${id}`);
    const { net, problems } = networkToVerify(id, entry, recorded, source);
    const cid = await readPublishedCid(net);
    if (cid !== entry.cid) problems.push(`${net.dotnsName} points at ${cid}, the release published ${entry.cid}`);
    try {
      problems.push(...diffDeployment(recorded, await readDeployment(net)));
      if (codehashes) problems.push(...(await checkLiveCode(net, recorded, codehashes)).problems);
    } catch (e) {
      problems.push(e instanceof Error ? e.message : String(e));
    }
    if (problems.length) {
      failed = true;
      console.log(`FAIL ${net.name}`);
      for (const p of problems) console.log(`     ${p}`);
    } else {
      console.log(
        `ok   ${net.name}: ${net.dotnsName} serves ${cid}; ${recorded.markets.length} markets match` +
          (codehashes ? "; code is the release's build" : ""),
      );
    }
  }
  process.exit(failed ? 1 : 0);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
