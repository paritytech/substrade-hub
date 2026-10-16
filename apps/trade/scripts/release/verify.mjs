/**
 * Check the chain against a release: each network's dotNS name must point at the release's CID, and
 * its contracts must match the release's deployments.json (same factory, faucet, quote and markets,
 * each with code). Exits non-zero on any mismatch.
 *
 * Usage (from the repo root, after `pnpm install`):
 *   node apps/trade/scripts/release/verify.mjs --tag dot-v1.2.3
 *   node apps/trade/scripts/release/verify.mjs --manifest <file> --deployments <file>
 * `--tag` downloads the two assets with the GitHub CLI (`gh`).
 *
 * A later release moves the names to a newer build, so an older release then reports a CID mismatch
 * on purpose: the check answers "is this release what the chain serves now".
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { readDeployment, readPublishedCid } from "./lib.mjs";

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
      repo: { type: "string", default: "paritytech/substrade-hub" },
    },
  });
  let { manifest: manifestFile, deployments: deploymentsFile } = values;
  if (values.tag) {
    const dir = mkdtempSync(join(tmpdir(), "substrade-release-"));
    execFileSync(
      "gh",
      ["release", "download", values.tag, "--repo", values.repo, "-D", dir, "-p", "release-manifest.json", "-p", "deployments.json"],
      { stdio: "inherit" },
    );
    manifestFile = join(dir, "release-manifest.json");
    deploymentsFile = join(dir, "deployments.json");
  }
  if (!manifestFile || !deploymentsFile) throw new Error("Pass --tag, or both --manifest and --deployments");
  const manifest = JSON.parse(readFileSync(manifestFile, "utf8"));
  const deployments = JSON.parse(readFileSync(deploymentsFile, "utf8"));

  console.log(`Verifying ${manifest.tag} (commit ${manifest.commit})`);
  let failed = false;
  for (const [id, entry] of Object.entries(manifest.networks)) {
    const recorded = deployments[id];
    if (!recorded) throw new Error(`deployments.json has no entry for ${id}`);
    const net = {
      name: entry.name,
      dotnsName: entry.dotnsName,
      rpcUrl: entry.rpcUrl,
      dotnsContentResolver: entry.dotnsContentResolver,
      chainId: recorded.chainId,
      genesis: recorded.genesis,
      factoryAddress: recorded.factory,
      faucetAddress: recorded.faucet,
      knownQuote: { addr: recorded.quote },
    };
    const problems = [];
    const cid = await readPublishedCid(net);
    if (cid !== entry.cid) problems.push(`${entry.dotnsName} points at ${cid}, the release published ${entry.cid}`);
    try {
      problems.push(...diffDeployment(recorded, await readDeployment(net)));
    } catch (e) {
      problems.push(e instanceof Error ? e.message : String(e));
    }
    if (problems.length) {
      failed = true;
      console.log(`FAIL ${entry.name}`);
      for (const p of problems) console.log(`     ${p}`);
    } else {
      console.log(`ok   ${entry.name}: ${entry.dotnsName} serves ${cid}; ${recorded.markets.length} markets match`);
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
