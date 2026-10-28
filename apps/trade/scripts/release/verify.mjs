// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: © 2026 Parity Technologies
/**
 * Check the chain against a release: each network's dotNS name must point at the release's CID, its
 * contracts must match the release's deployments.json (same factory, faucet, quote and markets, each
 * with code), and the code they run must be the release's build (codehashes.json: the implementation,
 * factory, libraries and faucet by masked codehash, every market a minimal proxy to the implementation).
 * Exits non-zero on any mismatch.
 *
 * The release's files only state what the chain should hold. Which networks to check, where to read
 * them (eth-rpc URL, content resolver, dotNS name) and which contracts they run (chain, factory, faucet,
 * quote token) come from `networks.json` in the repository: at the release's tag with `--tag`, otherwise
 * the checked-out file or `--networks`. A release whose files disagree with it, or leave a network out,
 * fails the check.
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
import { getAddress } from "viem";
import { readDeployment, readPublishedCid } from "./lib.mjs";
import { checkLiveCode } from "./codehash.mjs";

const NETWORKS_PATH = "apps/trade/src/config/networks.json";

/** Where to read a network: from `networks.json`, which the release manifest must repeat. */
const LOCATION_FIELDS = ["dotnsName", "rpcUrl", "dotnsContentResolver"];

/** `value` as a checksummed address, or null when it is not one. */
function address(value) {
  try {
    return getAddress(value);
  } catch {
    return null;
  }
}

/**
 * The network to read for `networks.json` entry `trusted`, built from that entry alone, and every way the
 * release's manifest entry (`entry`) and deployment record (`recorded`) disagree with it.
 */
export function networkToVerify(trusted, entry, recorded) {
  const problems = LOCATION_FIELDS.filter((k) => entry[k] !== trusted[k]).map(
    (k) => `the release manifest gives ${k} ${entry[k]}, networks.json gives ${trusted[k]}`,
  );
  const same = (a, b) => typeof a === "string" && typeof b === "string" && a.toLowerCase() === b.toLowerCase();
  if (recorded.chainId !== trusted.chainId) {
    problems.push(`the release records chainId ${recorded.chainId}, networks.json gives ${trusted.chainId}`);
  }
  if (!same(recorded.genesis, trusted.genesis)) {
    problems.push(`the release records genesis ${recorded.genesis}, networks.json gives ${trusted.genesis}`);
  }
  const contracts = { factory: trusted.factoryAddress, faucet: trusted.faucetAddress, quote: trusted.knownQuote?.addr };
  for (const [key, expected] of Object.entries(contracts)) {
    const got = address(recorded[key]);
    if (!got || got !== address(expected)) {
      problems.push(`the release records ${key} ${recorded[key]}, networks.json gives ${expected}`);
    }
  }
  const net = {
    name: trusted.name,
    dotnsName: trusted.dotnsName,
    rpcUrl: trusted.rpcUrl,
    dotnsContentResolver: trusted.dotnsContentResolver,
    chainId: trusted.chainId,
    genesis: trusted.genesis,
    factoryAddress: trusted.factoryAddress,
    faucetAddress: trusted.faucetAddress,
    knownQuote: { addr: trusted.knownQuote.addr },
  };
  return { net, problems };
}

/**
 * Every network the release's files must cover is in `networks.json`: one they leave out, or one the file
 * does not have, is a problem. Returns those problems and the ids the files do cover.
 */
export function coverage(source, manifest, deployments) {
  const problems = [];
  const released = manifest.networks ?? {};
  for (const id of new Set([...Object.keys(released), ...Object.keys(deployments)])) {
    if (!(id in source)) problems.push(`the release's files name ${id}, which networks.json does not have`);
  }
  const covered = [];
  for (const [id, n] of Object.entries(source)) {
    const missing = [!(id in released) && "release-manifest.json", !(id in deployments) && "deployments.json"].filter(Boolean);
    if (missing.length) problems.push(`${missing.join(" and ")} leave${missing.length > 1 ? "" : "s"} out ${n.name}`);
    else covered.push(id);
  }
  return { problems, covered };
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
  if (values.tag && values.networks) throw new Error("--networks only goes with local files: --tag reads networks.json at the tag");
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
    networksFile = join(dir, "networks.json");
    const source = execFileSync("gh", [
      "api",
      "-H",
      "Accept: application/vnd.github.raw",
      `repos/${values.repo}/contents/${NETWORKS_PATH}?ref=${encodeURIComponent(values.tag)}`,
    ]);
    writeFileSync(networksFile, source);
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
  const { problems: missing, covered } = coverage(source, manifest, deployments);
  for (const p of missing) {
    failed = true;
    console.log(`FAIL ${p}`);
  }
  for (const id of covered) {
    const [trusted, entry, recorded] = [source[id], manifest.networks[id], deployments[id]];
    const { net, problems } = networkToVerify(trusted, entry, recorded);
    const cid = await readPublishedCid(net);
    if (cid !== entry.cid) problems.push(`${net.dotnsName} points at ${cid}, the release published ${entry.cid}`);
    try {
      // The code check reads the contracts found on chain from networks.json's addresses, never the
      // release's record of them.
      const live = await readDeployment(net);
      problems.push(...diffDeployment(recorded, live));
      if (codehashes) problems.push(...(await checkLiveCode(net, live, codehashes)).problems);
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
