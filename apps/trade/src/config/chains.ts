/**
 * Network configuration. Every network the app can target lives in `networks.json`, and the build picks
 * one with `VITE_NETWORK` (no default, so a build never silently targets the wrong chain). After a chain
 * reset, only that file changes: the new genesis, plus the contract addresses the bootstrap script
 * writes. `vite.config.ts` fails the build when the selected genesis differs from its `.papi` entry.
 */
import networksJson from "./networks.json";

export interface ChainConfig {
  name: string;
  /** `.papi/polkadot-api.json` entry whose metadata matches this network's runtime. */
  papiEntry: string;
  /** Genesis hash: used to route/identify the chain through the host and to detect chain resets. */
  genesis: `0x${string}`;
  wsEndpoint: string;
  rpcUrl: string;
  chainId: number;
  /** Subscan-style explorer base URL; `null` when the network has none (explorer links are hidden). */
  explorerUrl: string | null;
  factoryAddress: `0x${string}`;
  /** Test-token faucet (dispenses `knownQuote`). Zero address = not deployed yet (UI hides the button). */
  faucetAddress: `0x${string}`;
  /**
   * The tUSD we actually control. Markets are filtered to this exact quote so a market quoted in a
   * same-named-but-different-asset "tUSD" never appears as a dead end for faucet tokens.
   */
  knownQuote: { addr: `0x${string}`; symbol: string; decimals: number };
}

const HASH = /^0x[0-9a-f]{64}$/i;
const ADDRESS = /^0x[0-9a-f]{40}$/i;
const FIELDS = [
  "name",
  "papiEntry",
  "genesis",
  "wsEndpoint",
  "rpcUrl",
  "chainId",
  "explorerUrl",
  "factoryAddress",
  "faucetAddress",
  "knownQuote",
];

function fail(network: string, message: string): never {
  throw new Error(`networks.json "${network}": ${message}`);
}

function url(network: string, field: string, value: unknown, protocols: string[]): string {
  if (typeof value !== "string") fail(network, `${field} must be a string`);
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    fail(network, `${field} is not a valid URL`);
  }
  if (!protocols.includes(parsed.protocol)) fail(network, `${field} must use ${protocols.join(" or ")}`);
  return value;
}

function address(network: string, field: string, value: unknown): `0x${string}` {
  if (typeof value !== "string" || !ADDRESS.test(value)) fail(network, `${field} must be a 20-byte hex address`);
  return value as `0x${string}`;
}

/** Strict parse: unknown or missing fields and malformed values are errors, never ignored. */
export function parseNetwork(network: string, raw: unknown): ChainConfig {
  if (typeof raw !== "object" || raw === null) fail(network, "must be an object");
  const r = raw as Record<string, unknown>;
  for (const key of Object.keys(r)) if (!FIELDS.includes(key)) fail(network, `unknown field "${key}"`);
  for (const key of FIELDS) if (!(key in r)) fail(network, `missing field "${key}"`);

  if (typeof r.name !== "string" || !r.name) fail(network, "name must be a non-empty string");
  if (typeof r.papiEntry !== "string" || !r.papiEntry) fail(network, "papiEntry must be a non-empty string");
  if (typeof r.genesis !== "string" || !HASH.test(r.genesis)) fail(network, "genesis must be a 32-byte hex hash");
  if (typeof r.chainId !== "number" || !Number.isSafeInteger(r.chainId) || r.chainId <= 0) {
    fail(network, "chainId must be a positive integer");
  }
  const q = r.knownQuote as Record<string, unknown> | null;
  if (typeof q !== "object" || q === null) fail(network, "knownQuote must be an object");
  if (typeof q.symbol !== "string" || !q.symbol) fail(network, "knownQuote.symbol must be a non-empty string");
  if (typeof q.decimals !== "number" || !Number.isInteger(q.decimals) || q.decimals < 0) {
    fail(network, "knownQuote.decimals must be a non-negative integer");
  }

  return {
    name: r.name,
    papiEntry: r.papiEntry,
    genesis: r.genesis as `0x${string}`,
    wsEndpoint: url(network, "wsEndpoint", r.wsEndpoint, ["wss:", "ws:"]),
    rpcUrl: url(network, "rpcUrl", r.rpcUrl, ["https:", "http:"]),
    chainId: r.chainId,
    explorerUrl: r.explorerUrl === null ? null : url(network, "explorerUrl", r.explorerUrl, ["https:"]),
    factoryAddress: address(network, "factoryAddress", r.factoryAddress),
    faucetAddress: address(network, "faucetAddress", r.faucetAddress),
    knownQuote: { addr: address(network, "knownQuote.addr", q.addr), symbol: q.symbol, decimals: q.decimals },
  };
}

/** Resolve the network named by `VITE_NETWORK`. Throws on a missing or unknown name. */
export function selectNetwork(name: string | undefined, networks: Record<string, unknown>): ChainConfig {
  const known = Object.keys(networks).join(", ");
  if (!name) throw new Error(`VITE_NETWORK is not set; expected one of: ${known}`);
  if (!Object.hasOwn(networks, name)) throw new Error(`VITE_NETWORK "${name}" is unknown; expected one of: ${known}`);
  return parseNetwork(name, networks[name]);
}

export const activeChain: ChainConfig = selectNetwork(
  import.meta.env.VITE_NETWORK as string | undefined,
  networksJson,
);
