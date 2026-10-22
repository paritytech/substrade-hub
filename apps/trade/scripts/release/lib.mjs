// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: © 2026 Parity Technologies
/**
 * What a release publishes, read from the chain: each network's dotNS contenthash (the published build)
 * and its contracts (factory, faucet, quote token and every market). `notes.mjs` builds the GitHub
 * Release's notes and assets from it; `verify.mjs` checks the chain against a release's assets.
 */
import { readFileSync } from "node:fs";
import { createPublicClient, getAddress, http, namehash, parseAbi } from "viem";

export const NETWORKS_FILE = new URL("../../src/config/networks.json", import.meta.url);

/** The networks of `networks.json`, keyed by network id, in file order. */
export function loadNetworks(file = NETWORKS_FILE) {
  return JSON.parse(readFileSync(file, "utf8"));
}

const factoryAbi = parseAbi([
  "function getMarketCount() view returns (uint256)",
  "function getMarketAt(uint256 index) view returns (address)",
]);
const marketAbi = parseAbi([
  "function getMarketInfo() view returns (address base, address quote, uint96 tick, uint96 minSize, uint128 maxSize)",
]);
const contentResolverAbi = parseAbi(["function contenthash(bytes32 node) view returns (bytes)"]);

/** `fn`, retried with backoff: public eth-rpc endpoints drop requests now and then. */
export async function withRetry(fn, attempts = 4) {
  for (let i = 1; ; i++) {
    try {
      return await fn();
    } catch (e) {
      if (i >= attempts) throw e;
      await new Promise((r) => setTimeout(r, 2000 * 2 ** (i - 1)));
    }
  }
}

const BASE32 = "abcdefghijklmnopqrstuvwxyz234567";

/**
 * The CID in an EIP-1577 IPFS contenthash (`0xe301` + CID bytes), as the lowercase base32 CIDv1 string
 * (`bafy...`) that bulletin-deploy prints. Throws for an empty or non-IPFS contenthash.
 */
export function contenthashToCid(hex) {
  const bytes = Buffer.from(hex.replace(/^0x/, ""), "hex");
  if (bytes.length < 3 || bytes[0] !== 0xe3 || bytes[1] !== 0x01) {
    throw new Error(`contenthash ${hex.slice(0, 18) || "0x"} is not an IPFS contenthash`);
  }
  let out = "b";
  let bits = 0;
  let value = 0;
  for (const byte of bytes.subarray(2)) {
    value = ((value << 8) | byte) & 0xffff;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31];
  return out;
}

/** The dot.li gateway URL of a dotNS name. */
export function gatewayUrl(dotnsName) {
  return `https://${dotnsName}.li`;
}

function client(rpcUrl) {
  return createPublicClient({ transport: http(rpcUrl, { timeout: 30_000 }) });
}

/** The CID that `net.dotnsName` points at on chain. */
export async function readPublishedCid(net) {
  const hash = await withRetry(() =>
    client(net.rpcUrl).readContract({
      address: net.dotnsContentResolver,
      abi: contentResolverAbi,
      functionName: "contenthash",
      args: [namehash(net.dotnsName)],
    }),
  );
  return contenthashToCid(hash);
}

/**
 * The network's contracts as deployed: the factory and faucet from `networks.json`, and every market the
 * factory lists, with its tokens. Fails when one of them has no code.
 */
export async function readDeployment(net) {
  const c = client(net.rpcUrl);
  const read = (address, abi, functionName, args = []) =>
    withRetry(() => c.readContract({ address, abi, functionName, args }));
  const factory = getAddress(net.factoryAddress);
  const count = Number(await read(factory, factoryAbi, "getMarketCount"));
  const markets = [];
  for (let i = 0; i < count; i++) {
    const address = getAddress(await read(factory, factoryAbi, "getMarketAt", [BigInt(i)]));
    const [base, quote] = await read(address, marketAbi, "getMarketInfo");
    markets.push({ address, base: getAddress(base), quote: getAddress(quote) });
  }
  const deployment = {
    chainId: net.chainId,
    genesis: net.genesis,
    factory,
    faucet: getAddress(net.faucetAddress),
    quote: getAddress(net.knownQuote.addr),
    markets,
  };
  for (const address of [deployment.factory, deployment.faucet, ...markets.map((m) => m.address)]) {
    const code = await withRetry(() => c.getCode({ address }));
    if (!code || code === "0x") throw new Error(`${net.name}: no contract code at ${address}`);
  }
  return deployment;
}

/** The fields of a deployment that a release compares, so a market added under the same factory counts. */
function contractsOf(d) {
  return JSON.stringify({ factory: d.factory, faucet: d.faucet, quote: d.quote, markets: d.markets ?? null });
}

/**
 * How the contracts changed since the previous release: the networks whose addresses changed and the
 * networks that are new. `previous` maps a network id to its previous deployment; one without `markets`
 * (read from an older `networks.json`) is compared on the factory, faucet and quote only.
 */
export function compareDeployments(current, previous) {
  const changed = [];
  const added = [];
  for (const [id, d] of Object.entries(current)) {
    const p = previous[id];
    if (!p) added.push(id);
    else if (contractsOf(p.markets ? d : { ...d, markets: undefined }) !== contractsOf(p)) changed.push(id);
  }
  return { changed, added };
}

/** The previous deployments from an older `networks.json`: factory, faucet and quote per network. */
export function deploymentsFromNetworks(networks) {
  return Object.fromEntries(
    Object.entries(networks).map(([id, n]) => [
      id,
      { factory: getAddress(n.factoryAddress), faucet: getAddress(n.faucetAddress), quote: getAddress(n.knownQuote.addr) },
    ]),
  );
}
