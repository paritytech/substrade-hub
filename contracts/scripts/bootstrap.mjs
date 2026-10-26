#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: © 2026 Parity Technologies
// Rebuild the SubsTrade Hub demo on a network from scratch: fund accounts, create the test assets,
// deploy the DLOB factory and the tUSD faucet, create the demo markets, seed their order books,
// generate a trade history for the candle chart, and write the resulting addresses into the app's
// networks.json. Run it again after a chain reset.
//
// Usage (from contracts/):
//   node scripts/bootstrap.mjs --network previewnet            # run every step
//   node scripts/bootstrap.mjs --network previewnet --only fund --fund 5Cto...   # one step
//   node scripts/bootstrap.mjs --help
//
// Every step is idempotent and records its result in a state file. A rerun skips finished work, so an
// interrupted run resumes where it stopped. If the chain was reset, the state file's genesis no longer
// matches and the script refuses to run until you delete that file.
//
// Signers: the funder pays native funds and is the admin of the test assets. EVM keys do everything
// else: the deployer deploys contracts, creates markets and seeds books; four more keys create trade
// history (separate keys, so takers never trade against their own orders). The keys come from one of:
// - DEPLOY_MNEMONIC: the funder is the mnemonic's root sr25519 account and the EVM keys are its BIP-44
//   accounts (m/44'/60'/0'/0/<index>), so the mnemonic alone recovers every key. The state file,
//   deployments/<network>.json, then holds no secret and is committed. The bootstrap workflow uses this.
// - FUNDER_URI (default //Alice; a mnemonic, optionally with a //path, also works) and random EVM keys,
//   kept in scripts/state/<network>.json (gitignored: it holds those keys).

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { AccountId, Binary, createClient, getSs58AddressInfo } from "polkadot-api";
import { getPolkadotSigner } from "polkadot-api/signer";
import { getWsProvider } from "polkadot-api/ws";
import { sr25519CreateDerive } from "@polkadot-labs/hdkd";
import { DEV_PHRASE, entropyToMiniSecret, mnemonicToEntropy } from "@polkadot-labs/hdkd-helpers";
import { TransactionReceiptNotFoundError, WaitForTransactionReceiptTimeoutError, createPublicClient, createWalletClient, defineChain, getContractAddress, http, parseAbi, toHex } from "viem";
import { generatePrivateKey, mnemonicToAccount, privateKeyToAccount } from "viem/accounts";
import { buildCodehashes, checkLiveCode, linkedLibraries, maskedCodehash } from "../../apps/trade/scripts/release/codehash.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const CONTRACTS = resolve(HERE, "..");
const NETWORKS_FILE = resolve(CONTRACTS, "../apps/trade/src/config/networks.json");

// ──────────────────────── Demo definition ──────────────────────────

const DECIMALS = 6; // base and quote must share decimals: the DLOB does no cross-decimal scaling
const UNIT = 10n ** BigInt(DECIMALS);
const PRECISION = 10n ** 18n; // prices are 18-decimal fixed point
const PAS = 10n ** 10n; // native planck per PAS
const WEI_PER_PAS = 10n ** 18n; // EVM-side native value

/** pallet-assets id that the runtime blocks from ERC-20 transfers; never trade it. */
const PROTECTED_ASSET_IDS = new Set([50_000_413]);

const QUOTE = { key: "tUSD", id: 50_000_698, name: "Test USD", supply: 10_000_000n * UNIT };
const FAUCET = { drip: 10_000n * UNIT, cooldownSeconds: 86_400, funding: 10_000_000n * UNIT };

const TICK_SIZE = PRECISION / 100n; // 0.01
const MIN_ORDER_SIZE = 1n * UNIT;
const MAX_ORDER_SIZE = 1_000_000n * UNIT;
// The factory's minCrossChainFee, in planck: each cross-chain settlement takes it from the order's
// reserve to pay for the XCM. 0.1 PAS covers a settlement to a sibling Asset Hub.
const CROSS_CHAIN_FEE = PAS / 10n;
const LEVEL_STEP = 0.5;
const BRIDGE_UNITS = 3;
const TAPER = [1, 2, 2, 3, 4, 5, 6, 7, 9, 12]; // depth per level, thin at the edges, deep at the spread

/** Ten bids up to `bestBid` and ten asks from `bestAsk`, each LEVEL_STEP apart, tapered toward the spread. */
function ladder(bestBid, bestAsk) {
  const bids = TAPER.map((amount, i) => ({ price: bestBid - (TAPER.length - 1 - i) * LEVEL_STEP, amount }));
  const asks = [...TAPER].reverse().map((amount, i) => ({ price: bestAsk + i * LEVEL_STEP, amount }));
  return { bids, asks };
}

// Target closes, one candle each: higher is a buy, lower a sell, equal a doji.
const MARKETS = [
  {
    key: "tNVDA",
    id: 50_000_699,
    name: "Test NVIDIA",
    supply: 100_000n * UNIT,
    ...ladder(220.0, 221.0),
    pricePath: [
      222.0, 222.5, 223.0, 223.5, 224.0, 224.0, 223.5, 222.5, 221.5, 222.5, 223.5, 224.5, 225.0, 225.0,
      224.5, 223.5, 222.5, 221.5, 220.5, 221.5, 222.5, 223.5, 224.5, 225.5, 224.5, 223.5, 223.0, 224.0,
      225.0, 224.5, 223.5,
    ],
  },
  {
    key: "tMU",
    id: 50_001_034,
    name: "Test Micron",
    supply: 10_000n * UNIT,
    ...ladder(939.5, 940.5),
    pricePath: [
      941.5, 942.0, 942.5, 943.0, 943.5, 943.5, 943.0, 942.0, 941.0, 942.0, 943.0, 944.0, 944.5, 944.5,
      944.0, 943.0, 942.0, 941.0, 940.0, 941.0, 942.0, 943.0, 944.0, 945.0, 944.0, 943.0, 942.5, 943.5,
      944.5, 944.0, 943.0,
    ],
  },
];

// Native funding per generated EVM account (PAS). Contract deploys and storage deposits come from the
// deployer; the trade-history keys only pay fees.
const FUNDING = { deployer: 300n, makerBid: 30n, makerAsk: 30n, buyer: 30n, seller: 30n };
const EXTRA_FUNDING = 50n; // per --fund account
/** BIP-44 address index of each EVM key under DEPLOY_MNEMONIC. Never renumber: it would change the keys. */
const KEY_INDEX = { deployer: 0, makerBid: 1, makerAsk: 2, buyer: 3, seller: 4 };
const TRADE_SPACING_MS = Number(process.env.TRADE_SPACING_S ?? 15) * 1000; // one candle per trade

// ──────────────────────── CLI ──────────────────────────

const STEPS = ["keys", "fund", "assets", "factory", "markets", "faucet", "seed", "history", "replenish", "config"];

function parseArgs(argv) {
  const args = { network: undefined, only: undefined, from: undefined, fund: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") args.help = true;
    else if (a === "--network") args.network = argv[++i];
    else if (a === "--only") args.only = argv[++i];
    else if (a === "--from") args.from = argv[++i];
    else if (a === "--fund") args.fund.push(argv[++i]);
    else throw new Error(`Unknown argument: ${a}`);
  }
  for (const s of [args.only, args.from]) {
    if (s !== undefined && !STEPS.includes(s)) throw new Error(`Unknown step "${s}"; steps: ${STEPS.join(", ")}`);
  }
  return args;
}

const HELP = `Usage: node scripts/bootstrap.mjs --network <name> [--only <step> | --from <step>] [--fund <ss58>]...

Steps, in order: ${STEPS.join(", ")}
  --network  a key of apps/trade/src/config/networks.json
  --only     run a single step        --from  run from a step onward
  --fund     also send ${EXTRA_FUNDING} PAS to this SS58 account (repeatable), e.g. a host product account
Env: DEPLOY_MNEMONIC (funder and EVM keys from one mnemonic) or FUNDER_URI (default //Alice),
     TRADE_SPACING_S (default 15)`;

// ──────────────────────── State ──────────────────────────

function loadJson(file) {
  return JSON.parse(readFileSync(file, "utf8"));
}

function saveJson(file, value) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

// ──────────────────────── Substrate helpers ──────────────────────────

function funderSigner(uri) {
  const [phrase, path] = uri.startsWith("//") ? [DEV_PHRASE, uri] : splitSuri(uri);
  const derive = sr25519CreateDerive(entropyToMiniSecret(mnemonicToEntropy(phrase)));
  const pair = derive(path);
  return getPolkadotSigner(pair.publicKey, "Sr25519", pair.sign);
}

function splitSuri(suri) {
  const i = suri.indexOf("//");
  return i === -1 ? [suri.trim(), ""] : [suri.slice(0, i).trim(), suri.slice(i)];
}

const ss58 = AccountId(42);

/** pallet-revive's fallback AccountId32 for an EVM address: H160 ++ 0xEE * 12. */
function evmToSs58(h160) {
  return ss58.dec(Binary.fromHex(`${h160.toLowerCase()}${"ee".repeat(12)}`));
}

function samePublicKey(address, publicKey) {
  const info = getSs58AddressInfo(address);
  return info.isValid && Binary.toHex(info.publicKey) === Binary.toHex(publicKey);
}

function assetErc20(id) {
  return `0x${id.toString(16).padStart(8, "0")}00000000000000000000000001200000`;
}

/** Submit and wait for finalization; throws on a failed dispatch. */
async function submit(tx, signer, label) {
  console.log(`  ${label}…`);
  const res = await tx.signAndSubmit(signer);
  if (!res.ok) throw new Error(`${label} failed: ${JSON.stringify(res.dispatchError, bigintJson)}`);
  console.log(`  ${label}: finalized in #${res.block.number}`);
}

function bigintJson(_key, value) {
  return typeof value === "bigint" ? value.toString() : value;
}

// ──────────────────────── EVM helpers ──────────────────────────

const ERC20_ABI = parseAbi([
  "function approve(address spender, uint256 amount) returns (bool)",
  "function transfer(address to, uint256 amount) returns (bool)",
  "function balanceOf(address owner) view returns (uint256)",
]);

function artifactAbi(file, name) {
  return loadJson(resolve(CONTRACTS, `out/${file}/${name}.json`)).abi;
}

/**
 * How long to wait for an EVM transaction's receipt per poll, how long one may stay pending after it is
 * sent, and how often to send a lost one.
 */
const TX_TIMEOUT_MS = 60_000;
const TX_PENDING_MS = 10 * 60_000;
const TX_ATTEMPTS = 3;

/**
 * Send a transaction from `account` (`send` receives the nonce to use) and wait for its receipt. eth-rpc
 * can accept a transaction and then lose it: no receipt, and the node no longer knows its hash. A lost
 * transaction is sent again with the same nonce, so at most one of the copies executes. eth-rpc can
 * also miss a transaction that did land: the nonce is used, but it has no record of the hash. Only
 * this run signs for `account`, so that transaction is ours; it resolves to null, since its outcome is
 * unknown. A transaction still pending `pendingMs` after it was sent stops the run, since sending it
 * again would need a higher fee to replace it; a rerun continues once it lands or drops.
 * `client` is a viem public client.
 */
export async function confirmTransaction(
  client,
  account,
  label,
  send,
  { timeoutMs = TX_TIMEOUT_MS, pendingMs = TX_PENDING_MS, attempts = TX_ATTEMPTS } = {},
) {
  const nonce = await client.getTransactionCount({ address: account, blockTag: "pending" });
  const used = async () => (await client.getTransactionCount({ address: account })) > nonce;
  for (let attempt = 1; ; attempt++) {
    const hash = await send(nonce);
    const sent = Date.now();
    for (;;) {
      try {
        return await client.waitForTransactionReceipt({ hash, timeout: timeoutMs });
      } catch (e) {
        // viem also gives up with "receipt not found" when eth-rpc reports a receipt late.
        if (!(e instanceof WaitForTransactionReceiptTimeoutError || e instanceof TransactionReceiptNotFoundError)) throw e;
      }
      // Still known to the node: pending, so keep waiting until the deadline.
      const pending = await client.getTransaction({ hash }).catch(() => null);
      if (pending && Date.now() - sent < pendingMs) continue;
      if (await used()) {
        console.log(`  ${label}: ${hash} landed (nonce ${nonce} is used), but eth-rpc has no receipt for it`);
        return null;
      }
      if (pending) throw new Error(`${label}: ${hash} is still pending after ${pendingMs / 1000}s`);
      break;
    }
    if (attempt === attempts) throw new Error(`${label}: the transaction was lost ${attempts} times`);
    console.log(`  ${label}: ${hash} was lost; sending it again (attempt ${attempt + 1} of ${attempts})`);
  }
}

/**
 * The environment forge runs with: the system basics and forge's own settings, plus what a script reads
 * (passed per call). Never DEPLOY_MNEMONIC, FUNDER_URI or anything else from this process: forge only
 * needs the deployer key it gets as an argument.
 */
function forgeEnv(extra = {}) {
  const keep = (name) =>
    ["PATH", "HOME", "TMPDIR", "LANG", "LC_ALL", "TERM", "CI", "NO_COLOR"].includes(name) || name.startsWith("FOUNDRY_");
  return { ...Object.fromEntries(Object.entries(process.env).filter(([name]) => keep(name))), ...extra };
}

/** Attempts at a forge broadcast, the pause between them, and how long one may run before it is stopped. */
const FORGE_ATTEMPTS = 3;
const FORGE_RETRY_MS = 15_000;
const FORGE_TIMEOUT_MS = 10 * 60_000;

/**
 * Broadcast a forge script. Forge can give up on a transaction whose receipt is not available yet, and
 * eth-rpc can drop a transaction it accepted. Each retry runs the script afresh: forge reads the
 * deployer's nonce from the chain and sends everything from there. A `--resume` retry would instead
 * wait for the dropped transaction, which never lands. A fresh run may deploy again a contract the
 * failed attempt did land (a library, say); the addresses recorded come from the latest broadcast, so
 * the run stays consistent and the cost is that deploy. An attempt running past `timeoutMs` is stopped
 * and counts as failed, so a stuck broadcast cannot hold the run.
 */
export async function forge(script, rpcUrl, privateKey, env = {}, { timeoutMs = FORGE_TIMEOUT_MS, retryMs = FORGE_RETRY_MS } = {}) {
  const args = ["script", `script/${script}`, "--rpc-url", rpcUrl, "--private-key", privateKey, "--broadcast", "--slow"];
  for (let attempt = 1; ; attempt++) {
    try {
      execFileSync("forge", args, {
        cwd: CONTRACTS,
        stdio: "inherit",
        env: forgeEnv(env),
        timeout: timeoutMs,
        killSignal: "SIGKILL",
      });
      return;
    } catch (e) {
      if (attempt === FORGE_ATTEMPTS) throw e;
      const why = e.code === "ETIMEDOUT" ? `stopped after ${timeoutMs / 1000}s` : "failed";
      console.log(`  forge ${why} (attempt ${attempt} of ${FORGE_ATTEMPTS}); running it again in ${retryMs / 1000}s`);
      await new Promise((r) => setTimeout(r, retryMs));
    }
  }
}

/** The address forge recorded for `contractName` in the latest broadcast of `script`. */
function broadcastAddress(script, chainId, contractName) {
  const run = loadJson(resolve(CONTRACTS, `broadcast/${script}/${chainId}/run-latest.json`));
  const tx = run.transactions.find((t) => t.transactionType === "CREATE" && t.contractName === contractName);
  if (!tx) throw new Error(`No ${contractName} deployment in the ${script} broadcast`);
  return tx.contractAddress;
}

/** The precompiles the factory is built with: XCM and System, at their fixed Asset Hub addresses. */
const XCM_PRECOMPILE = "0x00000000000000000000000000000000000a0000";
const SYSTEM_PRECOMPILE = "0x0000000000000000000000000000000000000900";

/** The creation bytecode of forge artifact `name`, with each library in `libraries` linked in. */
export function linkedBytecode(name, libraries = {}) {
  const { bytecode } = loadJson(resolve(CONTRACTS, `out/${name}.sol/${name}.json`));
  let hex = bytecode.object.replace(/^0x/, "");
  for (const libs of Object.values(bytecode.linkReferences ?? {})) {
    for (const [lib, refs] of Object.entries(libs)) {
      const address = libraries[lib];
      if (!address) throw new Error(`${name} links ${lib}, which is not deployed yet`);
      for (const { start, length } of refs) {
        hex = hex.slice(0, start * 2) + address.replace(/^0x/, "").toLowerCase() + hex.slice((start + length) * 2);
      }
    }
  }
  return `0x${hex}`;
}

function priceToRaw(price) {
  return BigInt(Math.round(price * 100)) * (PRECISION / 100n);
}

/** Quote needed for bids: sum of amount * price, rounded up per order. */
function quoteFor(orders) {
  return orders.reduce((sum, o) => sum + (BigInt(o.amount) * UNIT * priceToRaw(o.price) + PRECISION - 1n) / PRECISION, 0n);
}

// ──────────────────────── Trade-history planner ──────────────────────────

/**
 * Turn a price path into the bridge orders and trades that produce one candle per target close.
 * It simulates the book (seeded with `bids`/`asks`): a buy sweeps asks up to the target, a sell sweeps
 * bids down to it, a doji trades a single unit. When the needed side is empty it first adds bridge
 * orders of BRIDGE_UNITS every LEVEL_STEP between the previous close and the target, clamped to the
 * seeded range.
 */
export function planHistory({ bids, asks, pricePath }) {
  const low = bids[0].price;
  const high = asks[asks.length - 1].price;
  const book = { bids: new Map(bids.map((o) => [o.price, o.amount])), asks: new Map(asks.map((o) => [o.price, o.amount])) };
  const round = (n) => Math.round(n * 100) / 100;
  const best = (side, pick) => {
    const live = [...book[side]].filter(([, a]) => a > 0).map(([p]) => p);
    return live.length ? pick(...live) : null;
  };
  const steps = [];
  let prevClose = null;
  let prevSide = 0;

  for (const target of pricePath) {
    const doji = prevClose !== null && target === prevClose;
    const side = prevClose === null ? 0 : target > prevClose ? 0 : target < prevClose ? 1 : prevSide;
    const [resting, bestOf, beyond] =
      side === 0 ? ["asks", Math.min, (p) => p > target] : ["bids", Math.max, (p) => p < target];
    const top = best(resting, bestOf);

    if (top === null || beyond(top)) {
      const dir = side === 0 ? 1 : -1;
      const start = prevClose !== null ? round(prevClose - dir * LEVEL_STEP) : round(target - dir);
      for (let p = side === 0 ? round(Math.max(start, low)) : round(Math.min(start, high)); dir * (target - p) >= 0; p = round(p + dir * LEVEL_STEP)) {
        if ((book[resting].get(p) ?? 0) <= 0) {
          steps.push({ type: "bridge", side: side === 0 ? 1 : 0, price: p, amount: BRIDGE_UNITS });
          book[resting].set(p, (book[resting].get(p) ?? 0) + BRIDGE_UNITS);
        }
      }
    }

    if (doji) {
      const at = best(resting, bestOf);
      if (at !== null) {
        steps.push({ type: "trade", side, price: target, amount: 1 });
        book[resting].set(at, book[resting].get(at) - 1);
      }
    } else {
      let amount = 0;
      for (const [p, a] of book[resting]) {
        if (a > 0 && !beyond(p)) {
          amount += a;
          book[resting].set(p, 0);
        }
      }
      if (amount > 0) steps.push({ type: "trade", side, price: target, amount });
    }
    prevClose = target;
    prevSide = side;
  }
  return steps;
}

// ──────────────────────── Main ──────────────────────────

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.network) {
    console.log(HELP);
    process.exit(args.help ? 0 : 1);
  }

  const networks = loadJson(NETWORKS_FILE);
  const net = networks[args.network];
  if (!net) throw new Error(`Unknown network "${args.network}"; expected one of: ${Object.keys(networks).join(", ")}`);
  for (const a of [QUOTE, ...MARKETS]) {
    if (PROTECTED_ASSET_IDS.has(a.id)) throw new Error(`${a.key} uses protected asset id ${a.id}`);
  }

  const mnemonic = process.env.DEPLOY_MNEMONIC?.trim();
  if (mnemonic && process.env.FUNDER_URI) throw new Error("Set DEPLOY_MNEMONIC or FUNDER_URI, not both");
  const stateFile = mnemonic
    ? resolve(CONTRACTS, `deployments/${args.network}.json`)
    : resolve(HERE, `state/${args.network}.json`);
  const state = existsSync(stateFile)
    ? loadJson(stateFile)
    : { genesis: net.genesis, ...(mnemonic ? {} : { keys: {} }), done: {} };
  // A state file trimmed to redeploy (factory, markets and the seed/history marks removed) may lack it.
  state.done ??= {};
  const save = () => saveJson(stateFile, state);

  /** The EVM private key of `role`: derived from DEPLOY_MNEMONIC, or the random one in the state file. */
  const derivedKeys = {};
  const keyOf = (role) => {
    if (!mnemonic) return state.keys[role];
    if (!Object.hasOwn(KEY_INDEX, role)) throw new Error(`No KEY_INDEX for "${role}"`);
    derivedKeys[role] ??= toHex(mnemonicToAccount(mnemonic, { addressIndex: KEY_INDEX[role] }).getHdKey().privateKey);
    return derivedKeys[role];
  };
  if (mnemonic) {
    if (Object.keys(state.keys ?? {}).length) throw new Error(`${stateFile} holds private keys, which DEPLOY_MNEMONIC mode never stores`);
    // GitHub Actions masks secrets only verbatim; mask the derived keys too.
    if (process.env.GITHUB_ACTIONS) for (const role of Object.keys(KEY_INDEX)) console.log(`::add-mask::${keyOf(role)}`);
  }

  // Never destroyed: the process exits when main settles (see the entry point), and destroying the
  // client mid-follow can throw from a pending reconnect timer.
  const client = createClient(getWsProvider(net.wsEndpoint));
  const api = client.getUnsafeApi();
  const chainSpec = await client.getChainSpecData();
  const live = chainSpec.genesisHash;
  if (live !== net.genesis) {
    throw new Error(`${net.name} has genesis ${live}, networks.json says ${net.genesis}: update networks.json first`);
  }
  if (state.genesis !== live) {
    throw new Error(`${stateFile} belongs to genesis ${state.genesis}; the chain was reset, delete that file`);
  }

  const funder = funderSigner(mnemonic ?? process.env.FUNDER_URI ?? "//Alice");
  const funderSs58 = ss58.dec(funder.publicKey);
  const chain = defineChain({
    id: net.chainId,
    name: net.name,
    nativeCurrency: { name: "PAS", symbol: "PAS", decimals: 18 },
    rpcUrls: { default: { http: [net.rpcUrl] } },
  });
  const pub = createPublicClient({ chain, transport: http(net.rpcUrl) });
  const wallet = (role) => createWalletClient({ chain, transport: http(net.rpcUrl), account: privateKeyToAccount(keyOf(role)) });
  const addr = (role) => privateKeyToAccount(keyOf(role)).address;

  /** Send a transaction from `role` and wait for its receipt (see `confirmTransaction`). */
  const sendAndConfirm = (role, label, send) => confirmTransaction(pub, addr(role), label, send);

  /** Send a contract call from `role` and require a successful receipt, when eth-rpc has one. */
  const write = async (role, address, abi, functionName, fnArgs, value) => {
    const receipt = await sendAndConfirm(role, `${role} ${functionName}`, (nonce) =>
      wallet(role).writeContract({ address, abi, functionName, args: fnArgs, value, nonce }),
    );
    if (receipt && receipt.status !== "success") throw new Error(`${role} ${functionName} reverted (tx ${receipt.transactionHash})`);
    return receipt;
  };
  const read = (address, abi, functionName, fnArgs = []) => pub.readContract({ address, abi, functionName, args: fnArgs });
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  const start = args.only ?? args.from ?? STEPS[0];
  const run = (step) => (args.only ? step === args.only : STEPS.indexOf(step) >= STEPS.indexOf(start));
  const needs = (field, step) => {
    if (!state[field]) throw new Error(`Step "${step}" needs ${field}; run the earlier steps first`);
  };

  console.log(`Bootstrapping ${net.name} (funder ${funderSs58})`);

  if (run("keys")) {
    console.log("\n== keys ==");
    for (const role of Object.keys(FUNDING)) {
      if (!mnemonic) state.keys[role] ??= generatePrivateKey();
      console.log(`  ${role.padEnd(8)} ${addr(role)}`);
    }
    save();
  }

  if (run("fund")) {
    console.log("\n== fund ==");
    const targets = [
      ...Object.entries(FUNDING).map(([role, pas]) => [role, evmToSs58(addr(role)), pas]),
      ...args.fund.map((a) => [a, a, EXTRA_FUNDING]),
    ];
    const calls = [];
    for (const [label, account, pas] of targets) {
      const free = (await api.query.System.Account.getValue(account)).data.free;
      const want = pas * PAS;
      if (free >= want) console.log(`  ${label}: has ${free / PAS} PAS`);
      else {
        console.log(`  ${label}: topping up to ${pas} PAS`);
        calls.push(api.tx.Balances.transfer_keep_alive({ dest: { type: "Id", value: account }, value: want - free }).decodedCall);
      }
    }
    if (calls.length) await submit(api.tx.Utility.batch_all({ calls }), funder, "transfers");
  }

  if (run("assets")) {
    console.log("\n== assets ==");
    const deployerSs58 = evmToSs58(addr("deployer"));
    for (const a of [QUOTE, ...MARKETS]) {
      const existing = await api.query.Assets.Asset.getValue(a.id);
      if (existing) {
        if (!samePublicKey(existing.owner, funder.publicKey)) throw new Error(`Asset ${a.id} (${a.key}) exists and is owned by ${existing.owner}`);
        // A fresh state brings a new deployer, which holds none of an asset created by an earlier run.
        const held = (await api.query.Assets.Account.getValue(a.id, deployerSs58))?.balance ?? 0n;
        if (held >= a.supply) console.log(`  ${a.key} (${a.id}): exists`);
        else {
          const mint = api.tx.Assets.mint({ id: a.id, beneficiary: { type: "Id", value: deployerSs58 }, amount: a.supply - held });
          await submit(mint, funder, `${a.key} (${a.id}) exists; mint ${(a.supply - held) / UNIT} to the deployer`);
        }
        continue;
      }
      const calls = [
        api.tx.Assets.create({ id: a.id, admin: { type: "Id", value: funderSs58 }, min_balance: 1n }),
        api.tx.Assets.set_metadata({ id: a.id, name: Binary.fromText(a.name), symbol: Binary.fromText(a.key), decimals: DECIMALS }),
        api.tx.Assets.mint({ id: a.id, beneficiary: { type: "Id", value: deployerSs58 }, amount: a.supply }),
      ].map((t) => t.decodedCall);
      await submit(api.tx.Utility.batch_all({ calls }), funder, `create ${a.key} (${a.id})`);
    }
    state.assets = Object.fromEntries([QUOTE, ...MARKETS].map((a) => [a.key, assetErc20(a.id)]));
    save();
  }

  if (run("factory") || run("markets") || run("faucet") || run("seed") || run("history") || run("replenish")) {
    // Quiet: a full build prints forge-lint notes for the whole tree, which drown the bootstrap log.
    execFileSync("forge", ["build", "--quiet"], {
      cwd: CONTRACTS,
      stdio: ["ignore", "ignore", "inherit"],
      env: forgeEnv(),
    });
  }
  const factoryAbi = () => artifactAbi("DLOBFactory.sol", "DLOBFactory");
  const dlobAbi = () => artifactAbi("DLOB.sol", "DLOB");

  /**
   * The address of contract `name` running this build's code: `recorded` when its code there matches the
   * build (by masked codehash, as a release checks it, and linking `libraries`), else a new deploy from
   * the deployer. A deploy is sent through `sendAndConfirm`, so one that lands without an eth-rpc receipt
   * still counts: its address follows from the deployer's nonce, and its code is checked there.
   */
  const ensureContract = async (name, recorded, { libraries, args = [] } = {}) => {
    const { codehash, mask, links } = buildCodehashes(CONTRACTS).contracts[name];
    // The codehash masks library links, so the linked addresses are compared on their own.
    const runsBuild = (live) => {
      if (!live || maskedCodehash(live, mask) !== codehash) return false;
      if (!links) return true;
      const linked = linkedLibraries(live, links).libraries;
      return Object.keys(links).every((lib) => linked[lib]?.toLowerCase() === libraries?.[lib]?.toLowerCase());
    };
    if (recorded) {
      const live = await pub.getCode({ address: recorded });
      if (runsBuild(live)) {
        console.log(`  ${name} ${recorded} (runs this build)`);
        return recorded;
      }
      console.log(`  ${name} at ${recorded} ${live ? "runs other code or links other libraries" : "has no code"}; deploying a new one`);
    }
    const { abi } = loadJson(resolve(CONTRACTS, `out/${name}.sol/${name}.json`));
    let nonce;
    await sendAndConfirm("deployer", `deploy ${name}`, (n) => {
      nonce = n;
      return wallet("deployer").deployContract({ abi, bytecode: linkedBytecode(name, libraries), args, nonce: n });
    });
    const address = getContractAddress({ from: addr("deployer"), nonce: BigInt(nonce) });
    if (!runsBuild(await pub.getCode({ address }))) throw new Error(`${name} deploy left no matching code at ${address}`);
    console.log(`  ${name} ${address}`);
    return address;
  };

  if (run("factory")) {
    console.log("\n== factory ==");
    if (state.factory) {
      // The markets, books and history were made with the recorded factory, so it is kept, and has to run
      // this build (with this build's implementation and libraries) as a release checks it.
      const problems = (await pub.getCode({ address: state.factory }))
        ? await checkLiveCode(net, { factory: state.factory, markets: [] }, buildCodehashes(CONTRACTS), pub).then(
            (r) => r.problems,
            (e) => [`DLOBFactory at ${state.factory} could not be read: ${e.shortMessage ?? e.message}`],
          )
        : [`DLOBFactory at ${state.factory} has no code`];
      if (problems.length) {
        throw new Error(
          `The recorded factory does not run this build: ${problems.join("; ")}. To deploy new contracts, ` +
            `remove factory, markets, done and progress from ${stateFile} and run again`,
        );
      }
      console.log(`  DLOBFactory ${state.factory} (runs this build)`);
    } else {
      // Each contract is recorded as it lands, so a stopped run resumes with the next one.
      state.libraries ??= {};
      for (const lib of ["RedBlackTree", "XcmBuilder"]) {
        state.libraries[lib] = await ensureContract(lib, state.libraries[lib]);
        save();
      }
      state.implementation = await ensureContract("DLOB", state.implementation, { libraries: state.libraries });
      save();
      // msg.value counts in 18-decimal units: one planck is 10^(18 - the native token's decimals).
      const decimals = [chainSpec.properties?.tokenDecimals].flat()[0];
      if (!Number.isInteger(decimals)) throw new Error(`${net.name}'s chain spec has no tokenDecimals`);
      state.factory = await ensureContract("DLOBFactory", undefined, {
        args: [XCM_PRECOMPILE, SYSTEM_PRECOMPILE, state.implementation, 10n ** BigInt(18 - decimals)],
      });
      save();
    }
    // A fee of 0 disables cross-chain orders.
    if ((await read(state.factory, factoryAbi(), "minCrossChainFee")) !== CROSS_CHAIN_FEE) {
      await write("deployer", state.factory, factoryAbi(), "setMinCrossChainFee", [CROSS_CHAIN_FEE]);
      console.log(`  minCrossChainFee set to ${CROSS_CHAIN_FEE} planck`);
    }
  }

  if (run("markets")) {
    console.log("\n== markets ==");
    needs("factory", "markets");
    needs("assets", "markets");
    state.markets ??= {};
    const quote = state.assets[QUOTE.key];
    for (const m of MARKETS) {
      const base = state.assets[m.key];
      let market = await read(state.factory, factoryAbi(), "getMarket", [base, quote]);
      if (/^0x0{40}$/i.test(market)) {
        await write("deployer", state.factory, factoryAbi(), "createMarket", [
          { token: base, xcmLocation: "0x" },
          { token: quote, xcmLocation: "0x" },
          TICK_SIZE,
          MIN_ORDER_SIZE,
          MAX_ORDER_SIZE,
        ]);
        market = await read(state.factory, factoryAbi(), "getMarket", [base, quote]);
      }
      state.markets[m.key] = market;
      save();
      console.log(`  ${m.key}/${QUOTE.key} ${market}`);
      // The market's account needs an existential deposit before it can hold assets.
      if ((await pub.getBalance({ address: market })) === 0n) {
        await sendAndConfirm("deployer", `existential deposit for ${m.key}`, (nonce) =>
          wallet("deployer").sendTransaction({ to: market, value: WEI_PER_PAS, nonce }),
        );
      }
    }
  }

  if (run("faucet")) {
    console.log("\n== faucet ==");
    needs("assets", "faucet");
    if (state.faucet && (await pub.getCode({ address: state.faucet }))) console.log(`  deployed at ${state.faucet}`);
    else {
      await forge("DeployFaucet.s.sol", net.rpcUrl, keyOf("deployer"), {
        TUSD_ADDRESS: state.assets[QUOTE.key],
        FAUCET_DRIP: FAUCET.drip.toString(),
        FAUCET_COOLDOWN: String(FAUCET.cooldownSeconds),
      });
      state.faucet = broadcastAddress("DeployFaucet.s.sol", net.chainId, "Faucet");
      save();
      console.log(`  Faucet ${state.faucet}`);
    }
    const held = await read(state.assets[QUOTE.key], ERC20_ABI, "balanceOf", [state.faucet]);
    if (held < FAUCET.drip) {
      const mint = api.tx.Assets.mint({ id: QUOTE.id, beneficiary: { type: "Id", value: evmToSs58(state.faucet) }, amount: FAUCET.funding });
      await submit(mint, funder, `mint ${FAUCET.funding / UNIT} ${QUOTE.key} to the faucet`);
    } else console.log(`  holds ${held / UNIT} ${QUOTE.key}`);
  }

  /** Approve `market` for what `orders` need and place them from `role`. */
  /**
   * How many orders of `key` (a seed, history or replenish run of one market) have landed. Saved after
   * every order, so an interrupted run continues with the next order.
   */
  state.progress ??= {};
  const progressOf = (key) => state.progress[key] ?? 0;
  const advance = (key) => {
    state.progress[key] = progressOf(key) + 1;
    save();
  };

  const placeAll = async (role, m, orders, label, key) => {
    const market = state.markets[m.key];
    const bids = orders.filter((o) => o.side === 0);
    const asks = orders.filter((o) => o.side === 1);
    if (bids.length) await write(role, state.assets[QUOTE.key], ERC20_ABI, "approve", [market, quoteFor(bids)]);
    if (asks.length) {
      const base = asks.reduce((s, o) => s + BigInt(o.amount) * UNIT, 0n);
      await write(role, state.assets[m.key], ERC20_ABI, "approve", [market, base]);
    }
    for (const o of orders.slice(progressOf(key))) {
      await write(role, market, dlobAbi(), "placeLimitOrder", [o.side, priceToRaw(o.price), BigInt(o.amount) * UNIT, `0x${"0".repeat(64)}`, `0x${"0".repeat(64)}`, 0, 0n, false]);
      advance(key);
      console.log(`  ${label}: ${o.side === 0 ? "bid" : "ask"} ${o.amount} @ ${o.price.toFixed(2)}`);
    }
  };
  const ladderOrders = (m) => [...m.bids.map((o) => ({ ...o, side: 0 })), ...m.asks.map((o) => ({ ...o, side: 1 }))];

  for (const [step, label] of [["seed", "seed"], ["history", "history"], ["replenish", "replenish"]]) {
    if (!run(step)) continue;
    console.log(`\n== ${step} ==`);
    needs("markets", step);
    for (const m of MARKETS) {
      const doneKey = `${step}:${m.key}`;
      if (state.done[doneKey]) {
        console.log(`  ${m.key}: done`);
        continue;
      }
      if (step !== "history") await placeAll("deployer", m, ladderOrders(m), `${m.key} ${label}`, doneKey);
      else {
        const plan = planHistory(m);
        // Fund each history key from the deployer with what its part of the plan needs.
        const roleOf = (s) => (s.type === "bridge" ? (s.side === 0 ? "makerBid" : "makerAsk") : s.side === 0 ? "buyer" : "seller");
        const fundedKey = `${doneKey}:funded`;
        for (const role of state.done[fundedKey] ? [] : ["makerBid", "makerAsk", "buyer", "seller"]) {
          const mine = plan.filter((s) => roleOf(s) === role);
          const quote = 2n * quoteFor(mine.filter((s) => s.side === 0));
          const base = 2n * mine.filter((s) => s.side === 1).reduce((t, s) => t + BigInt(s.amount) * UNIT, 0n);
          if (quote > 0n) await write("deployer", state.assets[QUOTE.key], ERC20_ABI, "transfer", [addr(role), quote]);
          if (base > 0n) await write("deployer", state.assets[m.key], ERC20_ABI, "transfer", [addr(role), base]);
          if (quote > 0n) await write(role, state.assets[QUOTE.key], ERC20_ABI, "approve", [state.markets[m.key], quote]);
          if (base > 0n) await write(role, state.assets[m.key], ERC20_ABI, "approve", [state.markets[m.key], base]);
        }
        state.done[fundedKey] = true;
        save();
        for (const s of plan.slice(progressOf(doneKey))) {
          await write(roleOf(s), state.markets[m.key], dlobAbi(), "placeLimitOrder", [s.side, priceToRaw(s.price), BigInt(s.amount) * UNIT, `0x${"0".repeat(64)}`, `0x${"0".repeat(64)}`, 0, 0n, false]);
          advance(doneKey);
          console.log(`  ${m.key} ${s.type}: ${s.side === 0 ? "buy" : "sell"} ${s.amount} @ ${s.price.toFixed(2)}`);
          if (s.type === "trade") await sleep(TRADE_SPACING_MS);
        }
      }
      state.done[doneKey] = true;
      save();
    }
  }

  if (run("config")) {
    console.log("\n== config ==");
    needs("factory", "config");
    needs("faucet", "config");
    const fresh = loadJson(NETWORKS_FILE);
    Object.assign(fresh[args.network], {
      factoryAddress: state.factory,
      faucetAddress: state.faucet,
      knownQuote: { addr: state.assets[QUOTE.key], symbol: QUOTE.key, decimals: DECIMALS },
    });
    saveJson(NETWORKS_FILE, fresh);
    console.log(`  wrote ${args.network} addresses to ${NETWORKS_FILE}`);
  }
  console.log("\nDone.");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().then(
    () => process.exit(0),
    (e) => {
      console.error(`\n${e.message}`);
      process.exit(1);
    },
  );
}
