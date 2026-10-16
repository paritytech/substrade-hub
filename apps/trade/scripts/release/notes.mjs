/**
 * Build a release's notes header and assets from the chain, after every network has published:
 *   release-manifest.json  version, commit, and per network the dotNS name, gateway URL and CID
 *   deployments.json       per network the factory, faucet, quote token and markets
 *   notes.md               the header placed above GitHub's generated notes
 * The CIDs are read back from each name's contenthash, so the notes state what the chain serves.
 *
 * Usage (from the repo root):
 *   node apps/trade/scripts/release/notes.mjs --tag dot-v1.2.3 --commit <sha> --out <dir>
 *     [--previous-tag dot-v1.2.2] [--previous-deployments <file>] [--previous-networks <file>]
 * The previous release's deployments.json, or failing that its networks.json, gives the
 * "contracts changed" line. A hand-written intro is read from release-notes/<version>.md when present.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import {
  compareDeployments,
  deploymentsFromNetworks,
  gatewayUrl,
  loadNetworks,
  readDeployment,
  readPublishedCid,
} from "./lib.mjs";

const REPO_ROOT = new URL("../../../../", import.meta.url);

/** The notes header: an optional intro, where the release is live, and how its contracts changed. */
export function renderHeader({ tag, intro, manifest, comparison, previousTag, assetUrl }) {
  const rows = Object.values(manifest.networks).map(
    (n) => `| ${n.name} | \`${n.dotnsName}\` | [${n.url.replace("https://", "")}](${n.url}) | \`${n.cid}\` |`,
  );
  const names = (ids) => ids.map((id) => manifest.networks[id]?.name ?? id).join(", ");
  const contracts = [];
  if (!previousTag) {
    contracts.push("First release.");
  } else {
    if (comparison.changed.length) {
      contracts.push(`Addresses changed since \`${previousTag}\` on: ${names(comparison.changed)}. Update any pinned copy.`);
    }
    if (comparison.added.length) contracts.push(`Networks added since \`${previousTag}\`: ${names(comparison.added)}.`);
    if (!comparison.changed.length && !comparison.added.length) {
      contracts.push(`No contract changes since \`${previousTag}\`: every network uses the same factory and markets.`);
    }
  }
  return [
    ...(intro ? [intro.trim(), ""] : []),
    "## Where it is live",
    "",
    "| Network | dotNS name | Open | App CID |",
    "|---|---|---|---|",
    ...rows,
    "",
    "Each CID was read back from the name's on-chain contenthash after publishing.",
    "",
    "### Contracts",
    "",
    ...contracts,
    "",
    `Addresses for every network are in [\`deployments.json\`](${assetUrl("deployments.json")}), and the published builds in [\`release-manifest.json\`](${assetUrl("release-manifest.json")}).`,
    "",
    "### Verify",
    "",
    "```sh",
    "pnpm install --frozen-lockfile",
    `node apps/trade/scripts/release/verify.mjs --tag ${tag}`,
    "```",
    "",
    "checks each network's dotNS contenthash against the CID above, and the contracts on chain against `deployments.json`.",
    "",
  ].join("\n");
}

async function main() {
  const { values } = parseArgs({
    options: {
      tag: { type: "string" },
      commit: { type: "string" },
      out: { type: "string" },
      repo: { type: "string", default: process.env.GITHUB_REPOSITORY ?? "paritytech/substrade-hub" },
      "previous-tag": { type: "string" },
      "previous-deployments": { type: "string" },
      "previous-networks": { type: "string" },
    },
  });
  const { tag, commit, out, repo } = values;
  if (!tag || !/^dot-v\d+\.\d+\.\d+$/.test(tag)) throw new Error("--tag must be dot-vMAJOR.MINOR.PATCH");
  if (!commit || !out) throw new Error("--commit and --out are required");
  const version = tag.slice("dot-v".length);

  const networks = loadNetworks();
  const manifest = { version, tag, commit, networks: {} };
  const deployments = {};
  for (const [id, net] of Object.entries(networks)) {
    console.log(`Reading ${net.name}...`);
    manifest.networks[id] = {
      name: net.name,
      dotnsName: net.dotnsName,
      url: gatewayUrl(net.dotnsName),
      cid: await readPublishedCid(net),
      rpcUrl: net.rpcUrl,
      dotnsContentResolver: net.dotnsContentResolver,
    };
    deployments[id] = { name: net.name, rpcUrl: net.rpcUrl, ...(await readDeployment(net)) };
  }

  const previousTag = values["previous-tag"];
  let previous = {};
  if (values["previous-deployments"]) previous = JSON.parse(readFileSync(values["previous-deployments"], "utf8"));
  else if (values["previous-networks"]) previous = deploymentsFromNetworks(loadNetworks(values["previous-networks"]));

  const introFile = new URL(`release-notes/${version}.md`, REPO_ROOT);
  const header = renderHeader({
    tag,
    intro: existsSync(introFile) ? readFileSync(introFile, "utf8") : null,
    manifest,
    comparison: compareDeployments(deployments, previous),
    previousTag,
    assetUrl: (file) => `https://github.com/${repo}/releases/download/${tag}/${file}`,
  });

  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, "release-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  writeFileSync(join(out, "deployments.json"), `${JSON.stringify(deployments, null, 2)}\n`);
  writeFileSync(join(out, "notes.md"), header);
  console.log(`Wrote release-manifest.json, deployments.json and notes.md to ${out}`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
