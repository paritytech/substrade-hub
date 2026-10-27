// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: © 2026 Parity Technologies
// Measure what the DLOB's operations cost on the real runtime, on a Chopsticks fork of a live Asset Hub.
//
// The script creates a fresh market on the fork, with its own test assets and makers, builds each book
// state with real transactions, then dry-runs the measured call against it (`ReviveApi.call`). It
// reports ref_time and proof as a share of what one transaction may use, read from the runtime.
// Nothing reaches the live chain: start the fork first (`pnpm bench:fork`), then run
// `node scripts/bench/bench.mjs` from `contracts/`. See docs/benchmarks.md.

import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { AccountId, Binary, createClient } from "polkadot-api";
import { getTxCreator } from "polkadot-api/tx-creator";
import { getWsProvider } from "polkadot-api/ws";
import { sr25519CreateDerive } from "@polkadot-labs/hdkd";
import { DEV_PHRASE, entropyToMiniSecret, mnemonicToEntropy } from "@polkadot-labs/hdkd-helpers";
import { decodeErrorResult, decodeFunctionResult, encodeAbiParameters, encodeFunctionData, keccak256, toHex } from "viem";
import { linkedBytecode } from "../bootstrap.mjs";

const { values: args } = parseArgs({
  options: {
    network: { type: "string", default: "paseo-v2" },
    // "build": deploy contracts/out/ on the fork and measure it; "live": use the network's factory.
    contracts: { type: "string", default: "build" },
    endpoint: { type: "string", default: "ws://127.0.0.1:8011" },
    levels: { type: "string", default: "64,256" },
    sections: { type: "string", default: "empty,ladder,level,self,tree,cross-chain,expired" },
    out: { type: "string" },
    // Fail when a measured call uses more than this share (%) of the proof or ref_time limit.
    check: { type: "string" },
    // Append the results to this file as a Markdown table (CI passes $GITHUB_STEP_SUMMARY).
    summary: { type: "string" },
    // Warn about each row that moved more than this share (%) from the tables in docs/benchmarks.md.
    drift: { type: "string" },
    // Replace the tables in docs/benchmarks.md with this run's results.
    "write-docs": { type: "boolean", default: false },
    // Report on a saved --out file, without a fork.
    from: { type: "string" },
  },
});

const NETWORKS = JSON.parse(readFileSync(new URL("../../../apps/trade/src/config/networks.json", import.meta.url)));
const net = NETWORKS[args.network];
if (!net) throw new Error(`Unknown network "${args.network}"; pick one of ${Object.keys(NETWORKS).join(", ")}`);

const ALL_SECTIONS = ["empty", "ladder", "level", "self", "tree", "cross-chain", "expired"];
const DEFAULT_LEVELS = "64,256";
const sections = new Set(args.sections.split(","));
for (const name of sections) if (!ALL_SECTIONS.includes(name)) throw new Error(`Unknown section "${name}"; pick from ${ALL_SECTIONS.join(", ")}`);
const DOCS = new URL("../../docs/benchmarks.md", import.meta.url);
const START = "<!-- bench:results:start -->";
const END = "<!-- bench:results:end -->";

/** A row's label as the docs show it: a function name in code style, anything else capitalised. */
const docLabel = (label) => label.replace(/^([a-z]+[A-Z]\w*)/, "`$1`").replace(/^[a-z]/, (c) => c.toUpperCase());
/** The inverse of `docLabel`. */
const rowLabel = (cell) => cell.replaceAll("`", "").replace(/^[A-Z](?=[a-z ])/, (c) => c.toLowerCase());

/** The results as the docs' tables, one per group. */
function tables(results) {
  const pas = (planck) => {
    const v = Number(BigInt(planck)) / 1e10;
    return v === 0 ? "0" : v < 0.0001 ? "< 0.0001" : v.toFixed(4);
  };
  const note = (r) => (r.outcome === "ok" ? "" : r.outcome === "does not fit" ? "**does not fit**" : r.outcome.startsWith("Error(") ? "reverts: XCM execute failed" : `reverts ${r.outcome}`);
  return [...new Set(results.map((r) => r.group))]
    .map((g) => {
      const rows = results.filter((r) => r.group === g).map((r) => `| ${docLabel(r.label)} | ${(Number(r.proof) / 1e6).toFixed(2)} | ${r.proofPct}% | ${r.refTimePct}% | ${pas(r.deposit)} | ${pas(r.weightFee)} | ${note(r)} |`);
      return `### ${g}\n\n| Operation | Proof (MB) | Proof limit | ref_time limit | Deposit (PAS) | Weight fee (PAS) | Note |\n| --- | ---: | ---: | ---: | ---: | ---: | --- |\n${rows.join("\n")}\n`;
    })
    .join("\n");
}

/** The proof and ref_time shares (%) the docs report, by row label. */
function documented() {
  const doc = readFileSync(DOCS, "utf8");
  const shares = new Map();
  for (const line of doc.slice(doc.indexOf(START), doc.indexOf(END)).split("\n")) {
    const cells = line.split("|").map((c) => c.trim());
    if (cells.length < 5 || !cells[3]?.endsWith("%")) continue;
    shares.set(rowLabel(cells[1]), { proofPct: Number.parseFloat(cells[3]), refTimePct: Number.parseFloat(cells[4]) });
  }
  return shares;
}

/**
 * The rows whose proof or ref_time share moved more than `max` percent of its documented value. Shares
 * under 1% of a limit are skipped: the docs round them to two decimals, which alone can move them 5%.
 */
function drifted(results, max) {
  const docs = documented();
  const out = [];
  for (const r of results) {
    const d = docs.get(r.label);
    if (!d) {
      out.push({ label: r.label, detail: "not in docs/benchmarks.md" });
      continue;
    }
    for (const [key, name] of [["proofPct", "proof"], ["refTimePct", "ref_time"]]) {
      const was = d[key];
      if (was >= 1 && Math.abs(r[key] - was) / was > max / 100) out.push({ label: r.label, detail: `${name} ${was}% in the docs, ${r[key]}% now` });
    }
  }
  return out;
}

/**
 * Write the summary, the docs and the drift warnings for `results`, and exit. `run` says how they were
 * measured: `runtime`, `contracts`, and the `sections` and `levels` that ran.
 */
function report(results, run) {
  const { runtime: runtimeName, contracts } = run;
  const max = args.check === undefined ? undefined : Number(args.check);
  const over = max === undefined ? [] : results.filter((r) => !r.probe && (r.proofPct > max || r.refTimePct > max));
  const drift = args.drift === undefined ? [] : drifted(results, Number(args.drift));
  if (args.summary) {
    const rows = results.map((r) => `| ${r.group} | ${r.label}${r.probe ? " (ceiling probe)" : ""} | ${r.proofPct}% | ${r.refTimePct}% | ${r.outcome} |`);
    const verdict = max === undefined ? "" : over.length ? `**${over.length} over ${max}% of a limit.**` : `Every call fits within ${max}% of the limits.`;
    const stale = args.drift === undefined ? "" : drift.length ? `\n\n**docs/benchmarks.md is out of date** (moved more than ${args.drift}%): run \`pnpm bench --write-docs\` and commit it.\n\n${drift.map((x) => `- ${x.label}: ${x.detail}`).join("\n")}` : `\n\ndocs/benchmarks.md is up to date (within ${args.drift}%).`;
    appendFileSync(args.summary, `## Contract benchmarks\n\n${runtimeName}, contracts: ${contracts}. ${verdict}${stale}\n\n| Group | Operation | Proof | ref_time | Outcome |\n| --- | --- | ---: | ---: | --- |\n${rows.join("\n")}\n`);
  }
  for (const x of drift) console.log(`${process.env.GITHUB_ACTIONS ? "::warning title=Benchmarks out of date::" : "drift: "}${x.label}: ${x.detail}`);
  if (args["write-docs"]) {
    // The tables are the whole picture: only a run of every section at the default levels replaces them.
    const all = run.sections && ALL_SECTIONS.every((name) => run.sections.includes(name)) && run.sections.length === ALL_SECTIONS.length;
    if (!all || run.levels !== DEFAULT_LEVELS) {
      throw new Error(`--write-docs needs a run of every section at --levels ${DEFAULT_LEVELS}; this one ran ${run.sections?.join(",") ?? "unknown sections"} at ${run.levels ?? "unknown levels"}`);
    }
    if (results.length !== new Set(results.map((r) => r.label)).size) throw new Error("Duplicate row labels");
    const doc = readFileSync(DOCS, "utf8");
    const a = doc.indexOf(START);
    const b = doc.indexOf(END);
    if (a < 0 || b < a) throw new Error(`${DOCS.pathname} has no ${START} ... ${END} block`);
    writeFileSync(DOCS, `${doc.slice(0, a + START.length)}\n\n${tables(results)}\n${doc.slice(b)}`);
    console.log(`Wrote ${results.length} rows to docs/benchmarks.md (${runtimeName}); run npx prettier@3.3.3 --write on it before committing.`);
  }
  for (const r of over) console.error(`${r.label}: proof ${r.proofPct}%, ref_time ${r.refTimePct}%, over ${max}%`);
  // 2, so CI can tell a call over the limit (a retry changes nothing) from a failed run (exit 1).
  process.exit(over.length ? 2 : 0);
}

if (args.from) {
  const saved = JSON.parse(readFileSync(args.from, "utf8"));
  report(saved.results, saved);
}

const PAS = 10n ** 10n;
const UNIT = 10n ** 6n;
const PRICE = 10n ** 18n;
const TICK = PRICE / 100n;
const BUY = 0;
const SELL = 1;
const ZERO32 = `0x${"00".repeat(32)}`;
const XCM_PRECOMPILE = "0x00000000000000000000000000000000000a0000";
const SYSTEM_PRECOMPILE = "0x0000000000000000000000000000000000000900";
const MOCK_SIGNATURE = Uint8Array.from([0xde, 0xad, 0xbe, 0xef, ...new Array(60).fill(0xcd)]);

const artifact = (name) => JSON.parse(readFileSync(new URL(`../../out/${name}.sol/${name}.json`, import.meta.url))).abi;
const DLOB = artifact("DLOB");
const FACTORY = artifact("DLOBFactory");
const ERC20 = artifact("IERC20");

const json = (x) => JSON.stringify(x, (_, v) => (typeof v === "bigint" ? v.toString() : v instanceof Uint8Array ? toHex(v) : v));
const plain = (x) => JSON.parse(json(x));

let client;
let api;
/** (Re)connect: rewinding the fork with `dev_setHead` breaks a client's block subscription. */
function connect() {
  client?.destroy();
  client = createClient(getWsProvider(args.endpoint));
  api = client.getUnsafeApi();
}
connect();
const rpc = (method, params) => client._request(method, params);

const limits = (await api.constants.System.BlockWeights()).per_class.normal.max_extrinsic;
const runtime = await api.constants.System.Version();

const derive = sr25519CreateDerive(entropyToMiniSecret(mnemonicToEntropy(DEV_PHRASE)));
const run = Date.now().toString(36);

/** A fresh sr25519 account, signing for real. */
function account(name) {
  const kp = derive(`//bench/${run}/${name}`);
  return {
    name,
    ss58: AccountId().dec(kp.publicKey),
    h160: `0x${keccak256(toHex(kp.publicKey)).slice(26)}`,
    origin: toHex(kp.publicKey),
    signer: getTxCreator(kp.publicKey, "Sr25519", kp.sign),
  };
}

/** An existing EVM account, signed for with the fork's mock signature. */
function impersonate(h160) {
  const id = Uint8Array.from([...Buffer.from(h160.slice(2), "hex"), ...new Array(12).fill(0xee)]);
  return { name: "admin", ss58: AccountId().dec(id), h160, origin: toHex(id), signer: getTxCreator(id, "Sr25519", () => MOCK_SIGNATURE) };
}

const assetAddress = (id) => `0x${id.toString(16).padStart(8, "0")}${"0".repeat(24)}01200000`;

/** Dry-run a contract call as `from`, against the best block. */
async function dry(from, dest, abi, functionName, fnArgs, value = 0n) {
  const data = encodeFunctionData({ abi, functionName, args: fnArgs });
  const r = await api.apis.ReviveApi.call(from.ss58, dest, value, undefined, undefined, Binary.fromHex(data), { at: "best" });
  let error;
  if (!r.result.success) error = json(r.result.value);
  else if (r.result.value.flags & 1) {
    const raw = toHex(r.result.value.data);
    try {
      const e = decodeErrorResult({ abi: [...DLOB, ...FACTORY], data: raw });
      error = e.args?.length ? `${e.errorName}(${e.args.join(", ")})` : e.errorName;
    } catch {
      error = raw === "0x" ? "revert (no data)" : raw;
    }
  }
  return { data, weight: r.weight_required, deposit: r.storage_deposit.type === "Charge" ? r.storage_deposit.value : 0n, error, raw: r };
}

/** The `Revive.call` for a dry run, with headroom on its weight and deposit. */
function reviveCall(dest, d, value = 0n, headroom = 13n) {
  return api.tx.Revive.call({
    dest,
    value,
    weight_limit: { ref_time: (d.weight.ref_time * headroom) / 10n, proof_size: (d.weight.proof_size * headroom) / 10n },
    storage_deposit_limit: d.deposit * 2n + PAS,
    data: Binary.fromHex(d.data),
  });
}

async function submit(tx, from, label) {
  const r = await tx.createAndSubmit(from.signer);
  if (!r.ok) throw new Error(`${label}: ${json(r.dispatchError)}`);
  return r;
}

/** Send a contract call from `from`, failing on a revert. */
async function send(from, dest, abi, functionName, fnArgs, value = 0n) {
  const d = await dry(from, dest, abi, functionName, fnArgs, value);
  if (d.error) throw new Error(`${from.name} ${functionName}: ${d.error}`);
  await submit(reviveCall(dest, d, value), from, `${from.name} ${functionName}`);
  return d;
}

/**
 * Send several contract calls from `from`, packed into batches that fit one transaction. Each call is
 * dry-run against the state before its batch, and a later call in the batch can cost more (a resting
 * order in a bigger tree), so each gets twice its dry-run weight.
 */
async function sendMany(from, dest, abi, calls) {
  let batch = [];
  let used = 0n;
  const flush = async () => {
    if (batch.length) await submit(api.tx.Utility.batch_all({ calls: batch }), from, `${from.name} batch`);
    batch = [];
    used = 0n;
  };
  for (const [functionName, fnArgs] of calls) {
    const d = await dry(from, dest, abi, functionName, fnArgs);
    if (d.error) throw new Error(`${from.name} ${functionName}: ${d.error}`);
    const proof = d.weight.proof_size * 2n;
    if (used + proof > (limits.proof_size * 8n) / 10n) await flush();
    batch.push(reviveCall(dest, d, 0n, 20n).decodedCall);
    used += proof;
  }
  await flush();
}

const results = [];

/**
 * Dry-run the measured call and record its cost. `expect` is the error it should revert with, if any.
 * A `probe` is sized past what the docs say fits, to show where the ceiling is: `--check` skips it.
 */
async function measure(group, label, from, dest, abi, functionName, fnArgs, { value = 0n, expect, probe = false } = {}) {
  const d = await dry(from, dest, abi, functionName, fnArgs, value);
  // A dry run may use up to the block's weight, so a call too large for one transaction can still
  // succeed in it; one larger than the block runs out of gas and reverts with no data.
  const tooLarge = d.weight.proof_size > limits.proof_size || d.weight.ref_time > limits.ref_time;
  if (!tooLarge && (d.error ?? undefined) !== expect) throw new Error(`${label}: expected ${expect ?? "success"}, got ${d.error ?? "success"}`);
  const fee = await api.apis.TransactionPaymentApi.query_weight_to_fee(d.weight);
  const row = {
    group,
    label,
    refTime: d.weight.ref_time,
    proof: d.weight.proof_size,
    refTimePct: Number((d.weight.ref_time * 10000n) / limits.ref_time) / 100,
    proofPct: Number((d.weight.proof_size * 10000n) / limits.proof_size) / 100,
    deposit: d.deposit,
    weightFee: fee,
    outcome: tooLarge ? "does not fit" : (d.error ?? "ok"),
    probe,
  };
  results.push(row);
  console.log(`  ${label.padEnd(58)} proof ${String(row.proofPct).padStart(6)}%  ref_time ${String(row.refTimePct).padStart(6)}%  ${row.outcome}`);
  return d;
}

const head = async () => (await client.getBlockHeader()).number;
/** Rewind the fork to block `n`. Every block after it is dropped, so `n` must be on the current chain. */
async function rewind(n) {
  await rpc("dev_setHead", [n]);
  connect();
}
const now = async () => (await api.query.Timestamp.Now.getValue({ at: "best" })) / 1000n;

console.log(`Benchmarking on ${runtime.spec_name} ${runtime.spec_version}`);
console.log(`Per-transaction limits: ref_time ${limits.ref_time}, proof ${limits.proof_size} bytes\n`);

/** Deploy forge artifact `name` from `from`, linking `libraries`, and return its address. */
async function deploy(from, name, { libraries, args = [] } = {}) {
  const abi = artifact(name);
  const inputs = abi.find((x) => x.type === "constructor")?.inputs ?? [];
  // EVM init code takes its constructor arguments appended to it; pallet-revive's `data` stays empty.
  const encoded = inputs.length ? encodeAbiParameters(inputs, args).slice(2) : "";
  const code = Binary.fromHex(`${linkedBytecode(name, libraries)}${encoded}`);
  const data = Binary.fromHex("0x");
  const r = await api.apis.ReviveApi.instantiate(from.ss58, 0n, undefined, undefined, { type: "Upload", value: code }, data, undefined, { at: "best" });
  if (!r.result.success || r.result.value.result.flags & 1) throw new Error(`deploy ${name}: ${json(r.result.value)}`);
  const d = { weight: r.weight_required, deposit: r.storage_deposit.type === "Charge" ? r.storage_deposit.value : 0n };
  await submit(
    api.tx.Revive.instantiate_with_code({
      value: 0n,
      weight_limit: { ref_time: (d.weight.ref_time * 13n) / 10n, proof_size: (d.weight.proof_size * 13n) / 10n },
      storage_deposit_limit: d.deposit * 2n + PAS,
      code,
      data,
      salt: undefined,
    }),
    from,
    `deploy ${name}`,
  );
  return r.result.value.addr;
}

// == setup: funder, test assets, market, makers ==
const funder = account("funder");
await rpc("dev_setStorage", [plain({ System: { Account: [[[funder.ss58], { providers: 1, data: { free: 10_000_000n * PAS } }]] } })]);

const ids = [4_200_000_000 + Math.floor(Math.random() * 90_000_000)];
ids.push(ids[0] + 1);
const [baseId, quoteId] = ids;
const BASE = assetAddress(baseId);
const QUOTE = assetAddress(quoteId);

const MAKERS = 14;
const makers = Array.from({ length: MAKERS }, (_, i) => account(`maker${i}`));
const taker = account("taker");
const everyone = [...makers, taker];
// Deploys the build and administers its factory. Funded by transfer like the others: an account made
// by writing its storage, as the funder is, is never mapped to an H160 and cannot call contracts.
const deployer = account("deployer");
const MINT = 10n ** 12n * UNIT;

await submit(
  api.tx.Utility.batch_all({
    calls: [
      ...ids.flatMap((id) => [
        api.tx.Assets.create({ id, admin: { type: "Id", value: funder.ss58 }, min_balance: 1n }).decodedCall,
        api.tx.Assets.set_metadata({ id, name: Binary.fromText(`Bench ${id}`), symbol: Binary.fromText(`B${id % 1000}`), decimals: 6 }).decodedCall,
      ]),
      ...[...everyone, deployer].map((a) => api.tx.Balances.transfer_keep_alive({ dest: { type: "Id", value: a.ss58 }, value: 100_000n * PAS }).decodedCall),
    ],
  }),
  funder,
  "assets and accounts",
);
await submit(
  api.tx.Utility.batch_all({
    calls: everyone.flatMap((a) => ids.map((id) => api.tx.Assets.mint({ id, beneficiary: { type: "Id", value: a.ss58 }, amount: MINT }).decodedCall)),
  }),
  funder,
  "mint",
);

const read = async (dest, abi, fn, fnArgs = []) => {
  const d = await dry(funder, dest, abi, fn, fnArgs);
  return decodeFunctionResult({ abi, functionName: fn, data: toHex(d.raw.result.value.data) });
};
let factory;
let admin;
if (args.contracts === "build") {
  console.log("== deploy contracts/out/ ==");
  const libraries = {};
  for (const lib of ["RedBlackTree", "XcmBuilder"]) libraries[lib] = await deploy(deployer, lib);
  const implementation = await deploy(deployer, "DLOB", { libraries });
  // msg.value counts in 18-decimal units: one planck is 10^(18 - the native token's decimals).
  const decimals = [(await client.getChainSpecData()).properties?.tokenDecimals].flat()[0];
  if (!Number.isInteger(decimals)) throw new Error("The chain spec has no tokenDecimals");
  const ratio = 10n ** BigInt(18 - decimals);
  factory = await deploy(deployer, "DLOBFactory", { args: [XCM_PRECOMPILE, SYSTEM_PRECOMPILE, implementation, ratio] });
  admin = deployer;
  console.log(`  factory ${factory}, implementation ${implementation}`);
} else if (args.contracts === "live") {
  factory = net.factoryAddress;
  admin = impersonate(await read(factory, FACTORY, "admin"));
  await rpc("dev_setStorage", [plain({ System: { Account: [[[admin.ss58], { providers: 1, data: { free: 1_000_000n * PAS } }]] } })]);
} else {
  throw new Error(`--contracts is "build" or "live", not "${args.contracts}"`);
}
const creationDeposit = await read(factory, FACTORY, "marketCreationDeposit");
const marketArgs = [{ token: BASE, xcmLocation: "0x" }, { token: QUOTE, xcmLocation: "0x" }, TICK, UNIT / 1000n, 10n ** 9n * UNIT];

console.log("== factory ==");
await measure("Factory", "createMarket", admin, factory, FACTORY, "createMarket", marketArgs, { value: creationDeposit });
await send(admin, factory, FACTORY, "createMarket", marketArgs, creationDeposit);
const market = await read(factory, FACTORY, "getMarket", [BASE, QUOTE]);
// A factory starts with no cross-chain fee, which disables cross-chain orders: set the bootstrap's.
// Local orders do not read it.
if ((await read(factory, FACTORY, "minCrossChainFee")) === 0n) await send(admin, factory, FACTORY, "setMinCrossChainFee", [PAS / 10n]);
console.log(`  market ${market} (base ${baseId}, quote ${quoteId})`);

for (const a of everyone) {
  await submit(
    api.tx.Utility.batch_all({
      calls: await Promise.all(
        [BASE, QUOTE].map(async (t) => reviveCall(t, await dry(a, t, ERC20, "approve", [market, 2n ** 255n])).decodedCall),
      ),
    }),
    a,
    `${a.name} approve`,
  );
}

const ready = await head();
const px = (n) => BigInt(n) * TICK; // n hundredths of a quote unit
const limit = (side, price, amount, { owner, expire = 0n, postOnly = false } = {}) => ["placeLimitOrder", [side, price, amount, owner.origin, ZERO32, 0, expire, postOnly]];
const nextOrderId = async () => read(market, DLOB, "nextOrderId");

// == empty book ==
if (sections.has("empty")) {
  console.log("\n== empty book ==");
  await measure("Limit order, resting", "rest a buy, empty book", taker, market, DLOB, ...limit(BUY, px(10_000), UNIT, { owner: taker }));
  await measure("Market order", "market buy, empty book (fills nothing)", taker, market, DLOB, "placeMarketOrder", [BUY, UNIT, px(10_200), 0n, taker.origin, ZERO32, 0]);
}

// == a ladder of asks: one order from each of 7 makers, at 7 levels ==
console.log("\n== 7 asks at 7 levels, 16 bids ==");
for (let i = 0; i < 7; i++) await send(makers[i], market, DLOB, ...limit(SELL, px(10_100 + i), UNIT, { owner: makers[i] }));
await sendMany(makers[13], market, DLOB, Array.from({ length: 16 }, (_, i) => limit(BUY, px(9_900 - i), UNIT, { owner: makers[13] })));
const ladder = await head();

if (sections.has("ladder")) {
  for (let k = 1; k <= 7; k++) {
    await measure("Limit order, taking", `limit buy filling ${k} level${k > 1 ? "s" : ""}${k === 7 ? " (budget stops at 6)" : ""}`, taker, market, DLOB, ...limit(BUY, px(10_100 + k - 1), BigInt(k) * UNIT, { owner: taker }));
  }
  for (const k of [1, 6, 7]) {
    await measure("Market order", `market buy filling ${k} level${k > 1 ? "s" : ""}${k === 7 ? " (budget stops at 6)" : ""}`, taker, market, DLOB, "placeMarketOrder", [BUY, BigInt(k) * UNIT, px(10_200), 0n, taker.origin, ZERO32, 0]);
  }
  await measure("Market order", "all or nothing, 7 levels (rejected)", taker, market, DLOB, "placeMarketOrder", [BUY, 7n * UNIT, px(10_200), 7n * UNIT, taker.origin, ZERO32, 0], { expect: "SlippageExceeded" });
  await measure("Limit order, resting", "post-only buy that would cross (rejected)", taker, market, DLOB, ...limit(BUY, px(10_100), UNIT, { owner: taker, postOnly: true }), { expect: "PostOnlyWouldCross" });
  await measure("Limit order, resting", "rest a buy, new level, 16 bid levels", taker, market, DLOB, ...limit(BUY, px(9_950), UNIT, { owner: taker }));
  await measure("Limit order, resting", "rest a buy, existing level, 16 bid levels", taker, market, DLOB, ...limit(BUY, px(9_900), UNIT, { owner: taker }));

  const firstAsk = (await nextOrderId()) - 23;
  await measure("Cancel and reduce", "cancel the only order at its level (7 ask levels)", makers[0], market, DLOB, "cancelOrder", [firstAsk, makers[0].origin]);
  await measure("Cancel and reduce", "reduce an order", makers[0], market, DLOB, "reduceOrder", [firstAsk, UNIT / 2n, makers[0].origin]);
}

// == 14 orders at one level, from 14 makers ==
if (sections.has("level")) {
  console.log("\n== 14 asks at one level ==");
  await rewind(ladder);
  const fifoFirst = await nextOrderId();
  for (const m of makers) await send(m, market, DLOB, ...limit(SELL, px(10_050), UNIT, { owner: m }));
  for (const k of [1, 6]) {
    await measure("Limit order, taking", `limit buy filling ${k} order${k > 1 ? "s" : ""} at one level`, taker, market, DLOB, ...limit(BUY, px(10_050), BigInt(k) * UNIT, { owner: taker }));
  }
  await measure("Cancel and reduce", "cancel the first of 14 orders at a level", makers[0], market, DLOB, "cancelOrder", [fifoFirst, makers[0].origin]);
  await measure("Cancel and reduce", "cancel the 7th of 14 orders at a level", makers[6], market, DLOB, "cancelOrder", [fifoFirst + 6, makers[6].origin]);
  await measure("Cancel and reduce", "cancel the last of 14 orders at a level", makers[13], market, DLOB, "cancelOrder", [fifoFirst + 13, makers[13].origin]);
}

// == the taker's own orders at the front ==
if (sections.has("self")) {
  console.log("\n== self-trade ==");
  await rewind(ladder);
  await sendMany(taker, market, DLOB, Array.from({ length: 7 }, (_, i) => limit(SELL, px(10_000 + i), UNIT, { owner: taker })));
  await measure("Limit order, taking", "limit buy cancelling 6 own orders (budget stops)", taker, market, DLOB, ...limit(BUY, px(10_100), UNIT, { owner: taker }));
}

// == tree size ==
if (sections.has("tree")) {
  for (const n of args.levels.split(",").map(Number).filter((n) => n > 16)) {
    console.log(`\n== ${n} bid levels ==`);
    await rewind(ladder);
    const first = await nextOrderId();
    await sendMany(makers[12], market, DLOB, Array.from({ length: n - 16 }, (_, i) => limit(BUY, px(9_800 - i), UNIT, { owner: makers[12] })));
    await measure("Limit order, resting", `rest a buy, new level, ${n} bid levels`, taker, market, DLOB, ...limit(BUY, px(9_950), UNIT, { owner: taker }));
    await measure("Limit order, resting", `rest a buy, new worst level, ${n} bid levels`, taker, market, DLOB, ...limit(BUY, px(9_800 - n), UNIT, { owner: taker }));
    await measure("Cancel and reduce", `cancel the only order at its level, ${n} bid levels`, makers[12], market, DLOB, "cancelOrder", [first + Math.floor((n - 16) / 2), makers[12].origin]);
  }
}

// == cross-chain legs, settled to Paseo Asset Hub (para 1000) ==
if (sections.has("cross-chain")) {
  console.log("\n== cross-chain ==");
  const DEST = 1000;
  const minFee = await read(factory, FACTORY, "minCrossChainFee");
  const xLimit = (side, price, amount, owner) => ["placeLimitOrder", [side, price, amount, owner.origin, owner.origin, DEST, 0n, false]];
  const reserve = minFee * 7n;
  await rewind(ladder);
  for (const k of [1, 4, 5]) {
    await measure("Cross-chain", `limit buy filling ${k} level${k > 1 ? "s" : ""}, taker cross-chain${k === 5 ? " (budget stops at 4)" : ""}`, taker, market, DLOB, ...xLimit(BUY, px(10_100 + k - 1), BigInt(k) * UNIT, taker), { value: reserve });
  }

  await rewind(ready);
  for (let i = 0; i < 4; i++) await send(makers[i], market, DLOB, ...xLimit(SELL, px(10_100 + i), UNIT, makers[i]), reserve);
  const xAsk = (await nextOrderId()) - 4;
  for (const k of [1, 3, 4]) {
    await measure("Cross-chain", `limit buy filling ${k} level${k > 1 ? "s" : ""}, both legs cross-chain${k === 4 ? " (budget stops at 3)" : ""}`, taker, market, DLOB, ...xLimit(BUY, px(10_100 + k - 1), BigInt(k) * UNIT, taker), { value: reserve });
  }
  await measure("Cross-chain", "limit buy filling 1 level, maker cross-chain", taker, market, DLOB, ...limit(BUY, px(10_100), UNIT, { owner: taker }));
  await measure("Cross-chain", "cancel a cross-chain order", makers[0], market, DLOB, "cancelOrder", [xAsk, makers[0].origin]);
  await send(makers[0], market, DLOB, "cancelOrder", [xAsk, makers[0].origin]);
  // Cancelling a cross-chain order leaves a refund claim, which sends the escrow and the whole reserve.
  const refundClaim = (await read(market, DLOB, "nextClaimId")) - 1;
  await measure("Cross-chain", "claimSettlement, refund claim", taker, market, DLOB, "claimSettlement", [refundClaim], { value: minFee });
  await measure("Cross-chain", "redirectClaim, refund claim", makers[0], market, DLOB, "redirectClaim", [refundClaim, makers[0].origin, 1502]);

  // The taker's own cross-chain orders at the front: each is cancelled and refunded through a claim.
  await rewind(ready);
  for (let i = 0; i < 7; i++) await send(taker, market, DLOB, ...xLimit(SELL, px(10_000 + i), UNIT, taker), reserve);
  await measure("Cross-chain", "limit buy cancelling 6 own cross-chain orders (budget stops)", taker, market, DLOB, ...limit(BUY, px(10_100), UNIT, { owner: taker }));
}

// == expired orders (last: moving the clock forward and then rewinding the fork breaks block production) ==
if (sections.has("expired")) {
  console.log("\n== expired orders ==");
  await rewind(ready);
  const expire = (await now()) + 3600n;
  const expiredFirst = await nextOrderId();
  for (const m of makers.slice(0, 7)) await send(m, market, DLOB, ...limit(SELL, px(10_000), UNIT, { owner: m, expire }));
  const purgeFirst = await nextOrderId();
  await sendMany(makers[13], market, DLOB, Array.from({ length: 60 }, () => limit(SELL, px(10_099), UNIT, { owner: makers[13], expire })));
  // Cross-chain bids that expire: each is removed and refunded through a claim.
  const minFee = await read(factory, FACTORY, "minCrossChainFee");
  for (const m of makers.slice(7, 14)) await send(m, market, DLOB, "placeLimitOrder", [BUY, px(9_900), UNIT, m.origin, m.origin, 1000, expire, false], minFee * 7n);
  await rpc("dev_timeTravel", [Number((expire + 120n) * 1000n)]);
  await rpc("dev_newBlock", [{ count: 1 }]);
  await measure("Limit order, taking", "limit buy clearing 6 expired orders (budget stops)", taker, market, DLOB, ...limit(BUY, px(10_100), UNIT, { owner: taker }));
  await measure("Limit order, taking", "limit sell clearing 6 expired cross-chain orders (budget stops)", taker, market, DLOB, ...limit(SELL, px(9_800), UNIT, { owner: taker }));
  await measure("Cancel and reduce", "cancel an expired order", makers[0], market, DLOB, "cancelOrder", [expiredFirst, makers[0].origin]);
  // The docs say up to 25 and 20 orders fit.
  for (const n of [5, 10, 20, 25, 30]) {
    await measure("Purge expired", `purgeExpired, ${n} orders`, taker, market, DLOB, "purgeExpired", [SELL, px(10_099), n], { probe: n > 25 });
  }
  for (const n of [10, 20, 30, 40]) {
    await measure("Cancel and reduce", `batchCancelOrders, ${n} orders at one level`, makers[13], market, DLOB, "batchCancelOrders", [Array.from({ length: n }, (_, i) => purgeFirst + i), makers[13].origin], { probe: n > 20 });
  }
}

console.log(`\n${results.length} measurements`);
const measured = { runtime: `${runtime.spec_name} ${runtime.spec_version}`, contracts: args.contracts, sections: [...sections], levels: args.levels };
if (args.out) writeFileSync(args.out, `${JSON.stringify(plain({ ...measured, limits, results }), null, 2)}\n`);
client.destroy();
report(plain(results), measured);
