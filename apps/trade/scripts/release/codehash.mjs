/**
 * Which code is live. A release records, for each deployed contract, the keccak256 of its runtime
 * bytecode with the parts that differ per deployment masked: linked library addresses, immutables and
 * the CBOR metadata. The same masked hash then holds on every network, and the live code of any
 * deployment can be compared with it. `verify.mjs` and `notes.mjs` use `checkLiveCode`.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createPublicClient, getAddress, http, keccak256, parseAbi } from "viem";
import { withRetry } from "./lib.mjs";

/** The contracts a network deploys, by artifact name. */
export const CONTRACTS = ["DLOB", "DLOBFactory", "RedBlackTree", "XcmBuilder", "Faucet"];

/** The libraries the DLOB links, by artifact name. */
const DLOB_LIBRARIES = ["RedBlackTree", "XcmBuilder"];

/** forge's placeholder for an unlinked library address in an artifact's bytecode. */
const LINK_PLACEHOLDER = /__\$[0-9a-f]{34}\$__/g;

/**
 * keccak256 of runtime bytecode `hex` with the byte ranges in `mask` zeroed and the CBOR metadata
 * dropped (its length is the code's last two bytes). Unlinked library placeholders count as zeroes.
 */
export function maskedCodehash(hex, mask) {
  const code = Buffer.from(hex.replace(/^0x/, "").replace(LINK_PLACEHOLDER, "0".repeat(40)), "hex");
  // subarray clamps to the code's end: live code shorter than this build's layout hashes as a mismatch.
  for (const [start, length] of mask) code.subarray(start, start + length).fill(0);
  const metadata = code.length >= 2 ? code.readUInt16BE(code.length - 2) + 2 : 0;
  return keccak256(code.subarray(0, Math.max(0, code.length - metadata)));
}

/** The masked ranges and every library link offset of a forge artifact's runtime bytecode. */
function slotsOf(deployedBytecode) {
  const mask = [];
  const links = {};
  for (const libraries of Object.values(deployedBytecode.linkReferences ?? {})) {
    for (const [name, refs] of Object.entries(libraries)) {
      links[name] = refs.map((r) => r.start);
      for (const r of refs) mask.push([r.start, r.length]);
    }
  }
  for (const refs of Object.values(deployedBytecode.immutableReferences ?? {})) {
    for (const r of refs) mask.push([r.start, r.length]);
  }
  return { mask: mask.sort((a, b) => a[0] - b[0]), links };
}

/** The build settings in `foundry.toml` that decide the bytecode. */
function buildInputs(foundryToml) {
  const value = (key) => foundryToml.match(new RegExp(`^${key}\\s*=\\s*"?([^"\\n]+)"?`, "m"))?.[1]?.trim();
  return {
    solc: value("solc"),
    evmVersion: value("evm_version"),
    viaIr: value("via_ir") === "true",
    optimizer: value("optimizer") === "true",
    optimizerRuns: Number(value("optimizer_runs")),
  };
}

/** `codehashes.json` for a forge build in `contractsDir` (its `out/` and `foundry.toml`). */
export function buildCodehashes(contractsDir) {
  const contracts = {};
  for (const name of CONTRACTS) {
    const artifact = JSON.parse(readFileSync(join(contractsDir, "out", `${name}.sol`, `${name}.json`), "utf8"));
    const { mask, links } = slotsOf(artifact.deployedBytecode);
    contracts[name] = {
      codehash: maskedCodehash(artifact.deployedBytecode.object, mask),
      mask,
      ...(Object.keys(links).length ? { links } : {}),
    };
  }
  return { build: buildInputs(readFileSync(join(contractsDir, "foundry.toml"), "utf8")), contracts };
}

/** The 45-byte EIP-1167 runtime of a minimal proxy to `implementation`. */
export function eip1167Runtime(implementation) {
  return `0x363d3d373d3d3d363d73${implementation.slice(2).toLowerCase()}5af43d82803e903d91602b57fd5bf3`;
}

const factoryAbi = parseAbi([
  "function IMPLEMENTATION() view returns (address)",
  "function getMarket(address base, address quote) view returns (address)",
]);

/**
 * The address each library is linked at in `code` (runtime bytecode with this build's layout): the
 * same 20 bytes must sit at every link offset of a library. Returns the addresses and any problems.
 */
export function linkedLibraries(code, links) {
  const libraries = {};
  const problems = [];
  const hex = code.replace(/^0x/, "").toLowerCase();
  for (const [name, starts] of Object.entries(links ?? {})) {
    const found = new Set(starts.map((start) => hex.slice(start * 2, (start + 20) * 2)));
    const [address] = found;
    if (found.size !== 1 || address.length !== 40) {
      problems.push(`the implementation does not link one ${name} address at all of its ${starts.length} link sites`);
    } else {
      libraries[name] = getAddress(`0x${address}`);
    }
  }
  return { libraries, problems };
}

/**
 * Compare a network's live code with `codehashes`: the implementation, factory, linked libraries and
 * faucet (when `deployment` has one) must have the recorded hashes, every market must be an EIP-1167
 * proxy to the implementation, and the factory must return each market for its pair. The libraries
 * are found at the implementation's link sites, so they are only looked for when the implementation
 * matches this build: an implementation from another build has its link sites elsewhere. Returns the
 * implementation and library addresses found, and a list of problems (empty when everything matches).
 * `client` is a viem public client; one for `net.rpcUrl` is made when it is not given.
 */
export async function checkLiveCode(net, deployment, codehashes, client = undefined) {
  client ??= createPublicClient({ transport: http(net.rpcUrl, { timeout: 30_000 }) });
  const code = (address) => withRetry(() => client.getCode({ address })).then((c) => c ?? "0x");
  const read = (functionName, args = []) =>
    withRetry(() => client.readContract({ address: deployment.factory, abi: factoryAbi, functionName, args }));

  const problems = [];
  const implementation = getAddress(await read("IMPLEMENTATION"));
  const implementationCode = await code(implementation);

  /** Whether `live` (the code at `address`) is contract `name` of this build; records a problem if not. */
  const matches = (name, address, live) => {
    const recorded = codehashes.contracts[name];
    if (live === "0x") problems.push(`${name} at ${address} has no code`);
    else if (maskedCodehash(live, recorded.mask) !== recorded.codehash) {
      problems.push(`${name} at ${address} runs other code than this release's build`);
    } else return true;
    return false;
  };

  let libraries = {};
  if (matches("DLOB", implementation, implementationCode)) {
    const linked = linkedLibraries(implementationCode, codehashes.contracts.DLOB.links);
    problems.push(...linked.problems);
    for (const name of DLOB_LIBRARIES) {
      if (!codehashes.contracts.DLOB.links?.[name]) problems.push(`the release records no link for ${name}`);
    }
    libraries = linked.libraries;
    for (const [name, address] of Object.entries(libraries)) matches(name, address, await code(address));
  }
  for (const [name, address] of [["DLOBFactory", deployment.factory], ["Faucet", deployment.faucet]]) {
    if (address) matches(name, address, await code(address));
  }

  const proxy = eip1167Runtime(implementation);
  for (const market of deployment.markets) {
    if ((await code(market.address)).toLowerCase() !== proxy) {
      problems.push(`market ${market.address} is not a minimal proxy to ${implementation}`);
    }
    const listed = getAddress(await read("getMarket", [market.base, market.quote]));
    if (listed !== getAddress(market.address)) {
      problems.push(`the factory returns ${listed} for market ${market.address}'s pair`);
    }
  }
  return { implementation, libraries, problems };
}
