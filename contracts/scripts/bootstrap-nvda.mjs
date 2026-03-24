// Bootstrap tUSD/tNVDA market with realistic trade history.
//
// Reuses the existing DLOBFactory deployment. Creates new assets (tUSD, tNVDA),
// a new market at ~$175, seeds the order book, then generates ~11 matched trades
// with 15-second spacing to produce visible green/red candles on the chart.
//
// Requires in scripts/.env:
//   WSS_URL, RPC_URL, ALICE_SEED, DEPLOYER_PRIVATE_KEY, DLOB_FACTORY_ADDRESS
//
// Usage:
//   node scripts/bootstrap-nvda.mjs                  # run all phases
//   node scripts/bootstrap-nvda.mjs --from 4         # resume from phase 4
//   node scripts/bootstrap-nvda.mjs --only 3         # run only phase 3
//   node scripts/bootstrap-nvda.mjs --from 4 --to 5  # run phases 4 and 5
//
// When resuming, supply previously-created values via env or .env:
//   NVDA_QUOTE_ASSET_ID, NVDA_BASE_ASSET_ID, NVDA_MARKET_ADDRESS

import { ApiPromise, WsProvider, Keyring } from "@polkadot/api";
import { execSync } from "child_process";
import { readFileSync, existsSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, resolve } from "path";

// ──────────────────────── Load .env ─────────────────────────

const __dirname = dirname(fileURLToPath(import.meta.url));
const envPath = resolve(__dirname, ".env");
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq);
    let val = trimmed.slice(eq + 1);
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (!process.env[key]) process.env[key] = val;
  }
}

// ──────────────────────── CLI args ──────────────────────────

function parseArgs() {
  const args = process.argv.slice(2);
  let from = 1, to = 7;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--from" && args[i + 1]) { from = Number(args[++i]); to = 7; }
    else if (args[i] === "--to" && args[i + 1]) { to = Number(args[++i]); }
    else if (args[i] === "--only" && args[i + 1]) { from = to = Number(args[++i]); }
    else if (args[i] === "--help" || args[i] === "-h") {
      console.log(`Usage: node scripts/bootstrap-nvda.mjs [--from N] [--to N] [--only N]

Phases:
  1  Create Assets        (Substrate: tUSD + tNVDA)
  2  Create Market        (EVM: factory.createMarket)
  3  Seed Order Book      (EVM: Deployer places resting orders)
  4  Generate Trades      (EVM: Trader matches against book)
  5  Replenish Book       (EVM: Deployer refills levels)
  6  Fund UI Trader       (EVM: fund MetaMask account)
  7  Summary              (read-only checks)

When resuming from phase 2+, set in .env:
  NVDA_QUOTE_ASSET_ID=...
  NVDA_BASE_ASSET_ID=...

When resuming from phase 3+, also set:
  NVDA_MARKET_ADDRESS=...`);
      process.exit(0);
    }
  }
  if (from < 1 || from > 7 || to < 1 || to > 7 || from > to) {
    console.error("Invalid phase range. Use --help for usage.");
    process.exit(1);
  }
  return { from, to };
}

const { from: phaseFrom, to: phaseTo } = parseArgs();
const shouldRun = (n) => n >= phaseFrom && n <= phaseTo;

// ──────────────────────── Config ────────────────────────────

function requireEnv(name) {
  const val = process.env[name];
  if (!val) throw new Error(`Missing environment variable: ${name}`);
  return val;
}

function optionalEnv(name) {
  return process.env[name] || null;
}

const WSS_URL = requireEnv("WSS_URL");
const RPC_URL = requireEnv("RPC_URL");
const ALICE_SEED = requireEnv("ALICE_SEED");
const DEPLOYER_KEY = requireEnv("DEPLOYER_PRIVATE_KEY");
const FACTORY_ADDRESS = requireEnv("DLOB_FACTORY_ADDRESS");

// Token config
const QUOTE_NAME = "Test USD";
const QUOTE_SYMBOL = "tUSD";
const QUOTE_DECIMALS = 6;
const QUOTE_SUPPLY = 10_000_000_000_000n; // 10M

const BASE_NAME = "Test NVIDIA";
const BASE_SYMBOL = "tNVDA";
const BASE_DECIMALS = 6;
const BASE_SUPPLY = 100_000_000_000n; // 100K

// Market config (18-decimal fixed-point for prices)
const PRECISION = 10n ** 18n;
const TICK_SIZE = 10_000_000_000_000_000n; // 1e16 = 0.01
const MIN_ORDER_SIZE = 1_000_000n; // 1e6 = 1 token at 6 decimals
const MAX_ORDER_SIZE = 1_000_000_000_000n; // 1e12 = 1M tokens

// Convert a decimal price (e.g. 175.50) to 18-decimal fixed-point BigInt.
// 175.50 → 17550 cents → 17550 * 1e16 = 175500000000000000000
function priceToRaw(price) {
  const cents = Math.round(price * 100);
  return BigInt(cents) * (PRECISION / 100n);
}

// Seed orders: 10 bids + 10 asks spanning $170–$180, thin (3 units each)
// so trades punch through multiple levels creating $1–$2 candles.
const SEED_BIDS = [
  { price: 170.00, amount: 3n },
  { price: 170.50, amount: 3n },
  { price: 171.00, amount: 3n },
  { price: 171.50, amount: 3n },
  { price: 172.00, amount: 3n },
  { price: 172.50, amount: 3n },
  { price: 173.00, amount: 3n },
  { price: 173.50, amount: 3n },
  { price: 174.00, amount: 3n },
  { price: 174.50, amount: 3n },
];
const SEED_ASKS = [
  { price: 175.50, amount: 3n },
  { price: 176.00, amount: 3n },
  { price: 176.50, amount: 3n },
  { price: 177.00, amount: 3n },
  { price: 177.50, amount: 3n },
  { price: 178.00, amount: 3n },
  { price: 178.50, amount: 3n },
  { price: 179.00, amount: 3n },
  { price: 179.50, amount: 3n },
  { price: 180.00, amount: 3n },
];

const BASE_UNIT = 10n ** BigInt(BASE_DECIMALS);
const QUOTE_UNIT = 10n ** BigInt(QUOTE_DECIMALS);

// Phase 4 script: Trader takes, Maker places bridge orders.
// Three accounts: Deployer (seeds in phase 3), Maker (bridges), Trader (takes).
// Maker ≠ Deployer → no SelfTrade on bridges. Maker ≠ Trader → no SelfTrade on takes.
// On a clean book, Maker bridges rest below remaining asks / above remaining bids.
// Pattern: G G — R R G R R — G G
//
// Clean book: Bids 170(3)..174.50(3)=30  Asks 175.50(3)..180(3)=30
const PHASE4_SCRIPT = [
  // -- Green run: Trader eats seed asks 175.50→177 --
  // Each trade must span 2+ levels for a colored (non-grey) candle.
  { type: "trade", side: 0, amount: 7n },   //  1. BUY  7 → 175.50(3)+176(3)+176.50(1) → C=176.50 (green $1)
  { type: "trade", side: 0, amount: 5n },   //  2. BUY  5 → 176.50(2)+177(3) → C=177 (green $0.50)

  // Maker bids near 177 (remaining seed asks start at 177.50 → no cross)
  { type: "bridge", side: 0, price: 177.00, amount: 3n },
  { type: "bridge", side: 0, price: 176.50, amount: 3n },
  { type: "bridge", side: 0, price: 176.00, amount: 3n },
  { type: "bridge", side: 0, price: 175.50, amount: 3n },

  // -- Doji + Red: Trader sells into Maker bids + seed bids --
  { type: "trade", side: 1, amount: 1n },   //  3. SELL 1 → 1@177(maker) → C=177 (grey doji)
  { type: "trade", side: 1, amount: 5n },   //  4. SELL 5 → 2@177+3@176.50(maker) → C=176.50 (red $0.50)
  { type: "trade", side: 1, amount: 9n },   //  5. SELL 9 → 3@176+3@175.50(maker)+3@174.50(seed) → C=174.50 (red $2)

  // Maker asks near 175 (remaining seed bids top at 174 → no cross)
  { type: "bridge", side: 1, price: 175.00, amount: 3n },
  { type: "bridge", side: 1, price: 175.50, amount: 3n },
  { type: "bridge", side: 1, price: 176.00, amount: 3n },

  // -- Green bounce: Trader buys Maker asks --
  { type: "trade", side: 0, amount: 9n },   //  6. BUY  9 → 175(3)+175.50(3)+176(3)(maker) → C=176 (green $1.50)

  // Maker bids near 176 for the big red run (remaining seed asks at 177.50+ → no cross)
  { type: "bridge", side: 0, price: 176.00, amount: 3n },
  { type: "bridge", side: 0, price: 175.50, amount: 3n },
  { type: "bridge", side: 0, price: 175.00, amount: 3n },
  { type: "bridge", side: 0, price: 174.50, amount: 3n },
  { type: "bridge", side: 0, price: 174.00, amount: 3n },
  { type: "bridge", side: 0, price: 173.50, amount: 3n },
  { type: "bridge", side: 0, price: 173.00, amount: 3n },
  { type: "bridge", side: 0, price: 172.50, amount: 3n },

  // -- Red run --
  { type: "trade", side: 1, amount: 5n },   //  7. SELL 5 → 3@176+2@175.50(maker) → C=175.50 (red $0.50)
  { type: "trade", side: 1, amount: 19n },  //  8. SELL 19 → 1@175.50+3@175+3@174.50+3@174+3@173.50+3@173+3@172.50 → C=172.50 (red $3)

  // Maker asks near 173 (remaining seed bids at 172 and below → no cross)
  { type: "bridge", side: 1, price: 173.00, amount: 3n },
  { type: "bridge", side: 1, price: 173.50, amount: 3n },
  { type: "bridge", side: 1, price: 174.00, amount: 3n },
  { type: "bridge", side: 1, price: 174.50, amount: 3n },

  // -- Doji + Green finish: Trader buys Maker asks --
  { type: "trade", side: 0, amount: 1n },   //  9. BUY  1 → 1@173(maker) → C=173 (grey doji)
  { type: "trade", side: 0, amount: 5n },   // 10. BUY  5 → 2@173+3@173.50(maker) → C=173.50 (green $0.50)
  { type: "trade", side: 0, amount: 6n },   // 11. BUY  6 → 3@174+3@174.50(maker) → C=174.50 (green $1)
];

// Replenish: refill the full range so the book looks deep after trades
const REPLENISH_BIDS = [
  { price: 170.00, amount: 3n },
  { price: 170.50, amount: 3n },
  { price: 171.00, amount: 3n },
  { price: 171.50, amount: 3n },
  { price: 172.00, amount: 3n },
  { price: 172.50, amount: 3n },
  { price: 173.00, amount: 3n },
  { price: 173.50, amount: 3n },
  { price: 174.00, amount: 3n },
  { price: 174.50, amount: 3n },
];
const REPLENISH_ASKS = [
  { price: 175.50, amount: 3n },
  { price: 176.00, amount: 3n },
  { price: 176.50, amount: 3n },
  { price: 177.00, amount: 3n },
  { price: 177.50, amount: 3n },
  { price: 178.00, amount: 3n },
  { price: 178.50, amount: 3n },
  { price: 179.00, amount: 3n },
  { price: 179.50, amount: 3n },
  { price: 180.00, amount: 3n },
];

// ──────────────────────── Helpers ───────────────────────────

function evmToSubstrate(evmAddr) {
  const addr = evmAddr.toLowerCase().replace("0x", "");
  return "0x" + addr + "ee".repeat(12);
}

function assetIdToErc20(assetId) {
  const idHex = assetId.toString(16).padStart(8, "0");
  return `0x${idHex}00000000000000000000000001200000`;
}

function cast(args) {
  const cmd = `cast ${args} --rpc-url ${RPC_URL}`;
  console.log(`  > cast ${args.split(" ").slice(0, 3).join(" ")}...`);
  return execSync(cmd, { encoding: "utf8", timeout: 300_000 }).trim();
}

function castSend(to, sig, args, privateKey, value) {
  const valueFlag = value ? ` --value ${value}` : "";
  const cmd = `cast send ${to} "${sig}" ${args} --rpc-url ${RPC_URL} --private-key ${privateKey}${valueFlag}`;
  console.log(`  > cast send ... "${sig}"`);
  const result = execSync(cmd, { encoding: "utf8", timeout: 300_000 }).trim();
  const statusMatch = result.match(/status\s+(\d+)/);
  if (statusMatch && statusMatch[1] !== "1") {
    throw new Error(`Transaction failed! Full output:\n${result}`);
  }
  return result;
}

function sendAndWait(tx, signer, label, timeoutMs = 300_000) {
  return new Promise((resolve, reject) => {
    let resolved = false;
    let elapsed = 0;
    const tick = setInterval(() => {
      elapsed += 15;
      console.log(`  ${label}: waiting... (${elapsed}s)`);
    }, 15_000);
    const timer = setTimeout(() => {
      clearInterval(tick);
      if (!resolved) {
        resolved = true;
        reject(new Error(`${label}: timed out after ${timeoutMs / 1000}s waiting for finalization`));
      }
    }, timeoutMs);
    const cleanup = () => { clearTimeout(timer); clearInterval(tick); };
    tx.signAndSend(signer, ({ status, dispatchError, txHash }) => {
      if (status.isReady) console.log(`  ${label}: Ready (tx: ${txHash.toHex()})`);
      if (status.isBroadcast) console.log(`  ${label}: Broadcast`);
      if (status.isRetracted) console.log(`  ${label}: Retracted — waiting for re-inclusion...`);
      if (status.isInBlock) {
        console.log(`  ${label}: In block ${status.asInBlock.toHex()} (waiting for finalization...)`);
      }
      if (status.isFinalized) {
        cleanup();
        console.log(`  ${label}: Finalized in ${status.asFinalized.toHex()}`);
        if (dispatchError) {
          if (dispatchError.isModule) {
            const decoded = tx.registry.findMetaError(dispatchError.asModule);
            reject(new Error(`${label} failed: ${decoded.section}.${decoded.name}`));
          } else {
            reject(new Error(`${label} failed: ${dispatchError.toString()}`));
          }
          return;
        }
        if (!resolved) { resolved = true; resolve(); }
      }
    }).catch((err) => { cleanup(); reject(err); });
  });
}

function sleep(seconds) {
  console.log(`  Sleeping ${seconds}s...`);
  execSync(`sleep ${seconds}`);
}

// Compute token needs for Trader (buys + sells) and Maker (bridge bids + asks).
function traderQuoteNeeded() {
  let total = 0n;
  for (const s of PHASE4_SCRIPT) {
    if (s.type === "trade" && s.side === 0) {
      // BUY escrow: worst case ~$180 per unit
      total += s.amount * BASE_UNIT * priceToRaw(180.00) / PRECISION;
    }
  }
  return total * 2n;
}

function traderBaseNeeded() {
  let total = 0n;
  for (const s of PHASE4_SCRIPT) {
    if (s.type === "trade" && s.side === 1) total += s.amount * BASE_UNIT;
  }
  return total * 2n;
}

function makerQuoteNeeded() {
  let total = 0n;
  for (const s of PHASE4_SCRIPT) {
    if (s.type === "bridge" && s.side === 0) {
      total += (s.amount * BASE_UNIT * priceToRaw(s.price) + PRECISION - 1n) / PRECISION;
    }
  }
  return total * 2n;
}

function makerBaseNeeded() {
  let total = 0n;
  for (const s of PHASE4_SCRIPT) {
    if (s.type === "bridge" && s.side === 1) total += s.amount * BASE_UNIT;
  }
  return total * 2n;
}

// Compute escrow needed for bid orders (deployer)
function deployerQuoteForBids(orders) {
  let total = 0n;
  for (const o of orders) {
    const rawPrice = priceToRaw(o.price);
    const amount = o.amount * BASE_UNIT;
    // ceil(amount * price / 1e18)
    total += (amount * rawPrice + PRECISION - 1n) / PRECISION;
  }
  return total;
}

// Compute escrow needed for ask orders (deployer)
function deployerBaseForAsks(orders) {
  let total = 0n;
  for (const o of orders) {
    total += o.amount * BASE_UNIT;
  }
  return total;
}

// ──────────────────────── Main ──────────────────────────────

async function main() {
  console.log(`\n╔══════════════════════════════════════════╗`);
  console.log(`║  tNVDA/tUSD Market Bootstrap             ║`);
  console.log(`╚══════════════════════════════════════════╝`);
  console.log(`Running phases ${phaseFrom}${phaseTo !== phaseFrom ? `-${phaseTo}` : ""} of 7\n`);

  // Derive deployer address
  const deployerH160 = execSync(
    `cast wallet address --private-key ${DEPLOYER_KEY}`,
    { encoding: "utf8" }
  ).trim();
  const deployerSubstrate = evmToSubstrate(deployerH160);

  // Alice setup (sr25519 for Substrate extrinsics)
  const keyring = new Keyring({ type: "sr25519" });
  const alice = keyring.addFromUri(ALICE_SEED);

  // Helper to generate a fresh ECDSA wallet via cast
  function generateWallet(label) {
    const out = execSync("cast wallet new", { encoding: "utf8" }).trim();
    const addr = out.match(/Address:\s+(0x[0-9a-fA-F]{40})/);
    const key = out.match(/Private key:\s+(0x[0-9a-fA-F]{64})/);
    if (!addr || !key) throw new Error(`Failed to parse cast wallet new:\n${out}`);
    console.log(`Generated ${label}: ${addr[1]}`);
    return { h160: addr[1], key: key[1] };
  }

  // State that flows between phases
  let quoteId = optionalEnv("NVDA_QUOTE_ASSET_ID") ? Number(optionalEnv("NVDA_QUOTE_ASSET_ID")) : null;
  let baseId = optionalEnv("NVDA_BASE_ASSET_ID") ? Number(optionalEnv("NVDA_BASE_ASSET_ID")) : null;
  let quoteErc20 = quoteId != null ? assetIdToErc20(quoteId) : null;
  let baseErc20 = baseId != null ? assetIdToErc20(baseId) : null;
  let marketAddress = optionalEnv("NVDA_MARKET_ADDRESS") || null;

  function needAssets() {
    if (quoteId == null || baseId == null) {
      throw new Error("Resuming requires NVDA_QUOTE_ASSET_ID and NVDA_BASE_ASSET_ID in .env");
    }
  }
  function needMarket() {
    if (!marketAddress) {
      throw new Error("Resuming requires NVDA_MARKET_ADDRESS in .env");
    }
  }

  // Substrate connection (lazy)
  let api = null;
  async function connectSubstrate() {
    if (api) return api;
    const provider = new WsProvider(WSS_URL);
    api = await ApiPromise.create({
      provider,
      signedExtensions: {
        AuthorizeCall: { extrinsic: {}, payload: {} },
        EthSetOrigin: { extrinsic: {}, payload: {} },
        StorageWeightReclaim: { extrinsic: {}, payload: {} },
      },
    });
    return api;
  }

  // ─── Pre-flight ─────────────────────────────────────────
  console.log("=== Pre-flight ===");
  console.log(`Alice SS58:             ${alice.address}`);
  console.log(`Deployer H160:          ${deployerH160}`);
  console.log(`Factory:                ${FACTORY_ADDRESS}`);

  // ─── Phase 1: Create Assets ─────────────────────────────
  if (shouldRun(1)) {
    console.log("\n=== Phase 1: Create Assets (tUSD + tNVDA) ===\n");
    const sub = await connectSubstrate();

    const nextId = (await sub.query.assets.nextAssetId()).unwrap().toNumber();
    quoteId = nextId;
    baseId = nextId + 1;
    quoteErc20 = assetIdToErc20(quoteId);
    baseErc20 = assetIdToErc20(baseId);
    console.log(`Creating ${QUOTE_SYMBOL} (asset ${quoteId}) and ${BASE_SYMBOL} (asset ${baseId})...`);

    // Mint everything to Deployer's EVM-mapped Substrate address.
    // Trader + UI trader will be funded later via ERC20 transfer from Deployer.
    const txs = [
      sub.tx.assets.create(quoteId, alice.address, 1),
      sub.tx.assets.setMetadata(quoteId, QUOTE_NAME, QUOTE_SYMBOL, QUOTE_DECIMALS),
      sub.tx.assets.mint(quoteId, deployerSubstrate, QUOTE_SUPPLY.toString()),
      sub.tx.assets.create(baseId, alice.address, 1),
      sub.tx.assets.setMetadata(baseId, BASE_NAME, BASE_SYMBOL, BASE_DECIMALS),
      sub.tx.assets.mint(baseId, deployerSubstrate, BASE_SUPPLY.toString()),
    ];

    const batch = sub.tx.utility.batchAll(txs);
    await sendAndWait(batch, alice, "Create assets batch");

    console.log(`\n  ${QUOTE_SYMBOL}: asset ${quoteId} → ${quoteErc20}`);
    console.log(`  ${BASE_SYMBOL}: asset ${baseId} → ${baseErc20}`);
    console.log(`\n  Add to .env for resuming:`);
    console.log(`  NVDA_QUOTE_ASSET_ID=${quoteId}`);
    console.log(`  NVDA_BASE_ASSET_ID=${baseId}`);
  }

  // Disconnect Substrate after phase 1
  if (api) { await api.disconnect(); api = null; }

  // ─── Phase 2: Create Market ─────────────────────────────
  if (shouldRun(2)) {
    console.log("\n=== Phase 2: Create Market ===\n");
    needAssets();

    const emptyBytes = "0x";
    const baseTuple = `(${baseErc20},${emptyBytes})`;
    const quoteTuple = `(${quoteErc20},${emptyBytes})`;

    console.log(`Creating tNVDA/tUSD market (tick=0.01, min=1, max=1M)...`);
    castSend(
      FACTORY_ADDRESS,
      "createMarket((address,bytes),(address,bytes),uint96,uint96,uint128)",
      `"${baseTuple}" "${quoteTuple}" ${TICK_SIZE} ${MIN_ORDER_SIZE} ${MAX_ORDER_SIZE}`,
      DEPLOYER_KEY
    );

    // Find the new market — it's the latest one
    const marketCount = cast(`call ${FACTORY_ADDRESS} "getMarketCount()(uint256)"`);
    const lastIdx = BigInt(marketCount) - 1n;
    marketAddress = cast(
      `call ${FACTORY_ADDRESS} "getMarketAt(uint256)(address)" ${lastIdx}`
    );
    console.log(`\n  NVDA_MARKET_ADDRESS=${marketAddress}`);
  }

  // ─── Phase 3: Seed Order Book ───────────────────────────
  if (shouldRun(3)) {
    console.log("\n=== Phase 3: Seed Order Book (Deployer) ===\n");
    needAssets();
    needMarket();

    // -- Clean stale orders before seeding --
    console.log("Checking order book state...");
    const bestRaw = cast(`call ${marketAddress} "getBestPrices()(uint96,uint96)"`);
    // cast output may include annotations like "174500000000000000000 [1.745e20]"
    const parseCastBigInt = (s) => BigInt((s || "0").trim().split(/\s/)[0]);
    const [bestBidStr, bestAskStr] = bestRaw.split("\n");
    const bestBid = parseCastBigInt(bestBidStr);
    const bestAsk = parseCastBigInt(bestAskStr);

    if (bestBid > 0n || bestAsk > 0n) {
      console.log(`Book is dirty — best bid: ${bestBid}, best ask: ${bestAsk}`);

      // Read actual depth to compute exact sweep amounts.
      // cast output: "[3000000 [3e6], 103000000 [1.03e8], ...]" — strip annotations.
      const parseVolumes = (raw) => {
        const lines = raw.split("\n");
        const volLine = lines[1] || "[]";
        // Strip "[1.03e8]"-style annotations, then extract all integers
        const stripped = volLine.replace(/\[\d+(\.\d+)?e\d+\]/g, "");
        const nums = stripped.match(/\d+/g) || [];
        let total = 0n;
        for (const n of nums) total += BigInt(n);
        return total;
      };

      let totalAskVolume = 0n;
      let totalBidVolume = 0n;

      if (bestAsk > 0n) {
        const askBookRaw = cast(`call ${marketAddress} "getOrderBook(uint8,uint8)(uint96[],uint128[],uint8)" 1 20`);
        totalAskVolume = parseVolumes(askBookRaw);
        console.log(`  Ask-side volume to sweep: ${totalAskVolume}`);
      }
      if (bestBid > 0n) {
        const bidBookRaw = cast(`call ${marketAddress} "getOrderBook(uint8,uint8)(uint96[],uint128[],uint8)" 0 20`);
        totalBidVolume = parseVolumes(bidBookRaw);
        console.log(`  Bid-side volume to sweep: ${totalBidVolume}`);
      }

      console.log("Sweeping order book clean...\n");

      const sweepBuyer = generateWallet("SweepBuyer");
      const sweepSeller = generateWallet("SweepSeller");

      execSync(`cast send ${sweepBuyer.h160} --rpc-url ${RPC_URL} --private-key ${DEPLOYER_KEY} --value 5000000000000000000`, { encoding: "utf8", timeout: 300_000 });
      execSync(`cast send ${sweepSeller.h160} --rpc-url ${RPC_URL} --private-key ${DEPLOYER_KEY} --value 5000000000000000000`, { encoding: "utf8", timeout: 300_000 });

      const ZERO = "0x0000000000000000000000000000000000000000000000000000000000000000";

      // Sweep in chunks to stay within block weight limits.
      // ~10 tokens per tx is safe for proof_size.
      const SWEEP_CHUNK = 10n * BASE_UNIT;

      if (totalAskVolume > 0n) {
        const sweepQuote = (totalAskVolume * priceToRaw(200.00) + PRECISION - 1n) / PRECISION * 2n;
        castSend(quoteErc20, "transfer(address,uint256)", `${sweepBuyer.h160} ${sweepQuote}`, DEPLOYER_KEY);
        castSend(quoteErc20, "approve(address,uint256)", `${marketAddress} ${sweepQuote}`, sweepBuyer.key);
        let remaining = totalAskVolume;
        while (remaining > 0n) {
          const chunk = remaining > SWEEP_CHUNK ? SWEEP_CHUNK : remaining;
          console.log(`  Sweeping ${chunk} from asks (${remaining} left)...`);
          castSend(
            marketAddress,
            "placeLimitOrder(uint8,uint96,uint128,bytes32,bytes32,uint32,uint64)(uint32)",
            `0 ${priceToRaw(200.00)} ${chunk} ${ZERO} ${ZERO} 0 0`,
            sweepBuyer.key
          );
          remaining -= chunk;
        }
      }

      if (totalBidVolume > 0n) {
        const sweepBase = totalBidVolume * 2n;
        castSend(baseErc20, "transfer(address,uint256)", `${sweepSeller.h160} ${sweepBase}`, DEPLOYER_KEY);
        castSend(baseErc20, "approve(address,uint256)", `${marketAddress} ${sweepBase}`, sweepSeller.key);
        let remaining = totalBidVolume;
        while (remaining > 0n) {
          const chunk = remaining > SWEEP_CHUNK ? SWEEP_CHUNK : remaining;
          console.log(`  Sweeping ${chunk} from bids (${remaining} left)...`);
          castSend(
            marketAddress,
            "placeLimitOrder(uint8,uint96,uint128,bytes32,bytes32,uint32,uint64)(uint32)",
            `1 ${priceToRaw(100.00)} ${chunk} ${ZERO} ${ZERO} 0 0`,
            sweepSeller.key
          );
          remaining -= chunk;
        }
      }

      const afterRaw = cast(`call ${marketAddress} "getBestPrices()(uint96,uint96)"`);
      console.log(`  Book after sweep: ${afterRaw.replace(/\n/g, " / ")}`);
      console.log("  Order book cleaned.\n");
    } else {
      console.log("Book is empty — no cleanup needed.\n");
    }

    // Fund market contract with ED if needed
    const marketBal = BigInt(cast(`balance ${marketAddress}`));
    if (marketBal === 0n) {
      const ED_WEI = "1000000000000000000";
      console.log("Funding market contract with ED...");
      const cmd = `cast send ${marketAddress} --rpc-url ${RPC_URL} --private-key ${DEPLOYER_KEY} --value ${ED_WEI}`;
      console.log(`  > cast send ${marketAddress} --value ${ED_WEI}`);
      execSync(cmd, { encoding: "utf8", timeout: 300_000 });
    }

    // Calculate approvals
    const quoteNeeded = deployerQuoteForBids(SEED_BIDS) * 2n;
    const baseNeeded = deployerBaseForAsks(SEED_ASKS) * 2n;

    console.log(`Approving ${quoteNeeded} quote (tUSD) to market...`);
    castSend(quoteErc20, "approve(address,uint256)", `${marketAddress} ${quoteNeeded}`, DEPLOYER_KEY);
    console.log(`Approving ${baseNeeded} base (tNVDA) to market...`);
    castSend(baseErc20, "approve(address,uint256)", `${marketAddress} ${baseNeeded}`, DEPLOYER_KEY);

    const ZERO_BYTES32 = "0x0000000000000000000000000000000000000000000000000000000000000000";

    console.log("\nPlacing bid orders...");
    for (const { price, amount } of SEED_BIDS) {
      const rawPrice = priceToRaw(price);
      const rawAmount = amount * BASE_UNIT;
      console.log(`  BID ${amount} tNVDA @ $${price}`);
      castSend(
        marketAddress,
        "placeLimitOrder(uint8,uint96,uint128,bytes32,bytes32,uint32,uint64)(uint32)",
        `0 ${rawPrice} ${rawAmount} ${ZERO_BYTES32} ${ZERO_BYTES32} 0 0`,
        DEPLOYER_KEY
      );
    }

    console.log("\nPlacing ask orders...");
    for (const { price, amount } of SEED_ASKS) {
      const rawPrice = priceToRaw(price);
      const rawAmount = amount * BASE_UNIT;
      console.log(`  ASK ${amount} tNVDA @ $${price}`);
      castSend(
        marketAddress,
        "placeLimitOrder(uint8,uint96,uint128,bytes32,bytes32,uint32,uint64)(uint32)",
        `1 ${rawPrice} ${rawAmount} ${ZERO_BYTES32} ${ZERO_BYTES32} 0 0`,
        DEPLOYER_KEY
      );
    }

    console.log("\nOrder book seeded.");
  }

  // ─── Phase 4: Generate Trade History ────────────────────
  if (shouldRun(4)) {
    console.log("\n=== Phase 4: Generate Trade History (Trader) ===\n");
    needAssets();
    needMarket();

    // -- Generate fresh Trader + Maker accounts --
    const trader = generateWallet("Trader");
    const maker = generateWallet("Maker");

    // -- Fund both with PAS for gas --
    console.log("\nFunding Trader + Maker with 10 PAS each...");
    execSync(`cast send ${trader.h160} --rpc-url ${RPC_URL} --private-key ${DEPLOYER_KEY} --value 10000000000000000000`, { encoding: "utf8", timeout: 300_000 });
    execSync(`cast send ${maker.h160} --rpc-url ${RPC_URL} --private-key ${DEPLOYER_KEY} --value 10000000000000000000`, { encoding: "utf8", timeout: 300_000 });

    // -- Transfer tokens --
    const tQuote = traderQuoteNeeded();
    const tBase = traderBaseNeeded();
    const mQuote = makerQuoteNeeded();
    const mBase = makerBaseNeeded();

    console.log(`Transferring tokens to Trader (${tQuote} tUSD, ${tBase} tNVDA)...`);
    castSend(quoteErc20, "transfer(address,uint256)", `${trader.h160} ${tQuote}`, DEPLOYER_KEY);
    castSend(baseErc20, "transfer(address,uint256)", `${trader.h160} ${tBase}`, DEPLOYER_KEY);
    console.log(`Transferring tokens to Maker (${mQuote} tUSD, ${mBase} tNVDA)...`);
    castSend(quoteErc20, "transfer(address,uint256)", `${maker.h160} ${mQuote}`, DEPLOYER_KEY);
    castSend(baseErc20, "transfer(address,uint256)", `${maker.h160} ${mBase}`, DEPLOYER_KEY);

    // -- Approvals --
    castSend(quoteErc20, "approve(address,uint256)", `${marketAddress} ${tQuote}`, trader.key);
    castSend(baseErc20, "approve(address,uint256)", `${marketAddress} ${tBase}`, trader.key);
    castSend(quoteErc20, "approve(address,uint256)", `${marketAddress} ${mQuote}`, maker.key);
    castSend(baseErc20, "approve(address,uint256)", `${marketAddress} ${mBase}`, maker.key);

    const ZERO_BYTES32 = "0x0000000000000000000000000000000000000000000000000000000000000000";
    const tradeCount = PHASE4_SCRIPT.filter((s) => s.type === "trade").length;
    let tradeNum = 0;

    console.log(`\nExecuting ${tradeCount} trades with bridge orders (15s between trades)...\n`);
    for (const step of PHASE4_SCRIPT) {
      if (step.type === "bridge") {
        const rawPrice = priceToRaw(step.price);
        const rawAmount = step.amount * BASE_UNIT;
        const sideLabel = step.side === 0 ? "BID" : "ASK";
        console.log(`  Bridge: ${sideLabel} ${step.amount} @ $${step.price}`);
        castSend(
          marketAddress,
          "placeLimitOrder(uint8,uint96,uint128,bytes32,bytes32,uint32,uint64)(uint32)",
          `${step.side} ${rawPrice} ${rawAmount} ${ZERO_BYTES32} ${ZERO_BYTES32} 0 0`,
          maker.key
        );
      } else {
        tradeNum++;
        const rawAmount = step.amount * BASE_UNIT;
        const sideLabel = step.side === 0 ? "BUY" : "SELL";
        const aggressivePrice = step.side === 0
          ? priceToRaw(200.00)
          : priceToRaw(155.00);

        console.log(`  Trade ${tradeNum}/${tradeCount}: ${sideLabel} ${step.amount} tNVDA`);
        castSend(
          marketAddress,
          "placeLimitOrder(uint8,uint96,uint128,bytes32,bytes32,uint32,uint64)(uint32)",
          `${step.side} ${aggressivePrice} ${rawAmount} ${ZERO_BYTES32} ${ZERO_BYTES32} 0 0`,
          trader.key
        );

        if (tradeNum < tradeCount) {
          sleep(15);
        }
      }
    }

    console.log("\nTrade history generated.");
  }

  // ─── Phase 5: Replenish Order Book ──────────────────────
  if (shouldRun(5)) {
    console.log("\n=== Phase 5: Replenish Order Book (Deployer) ===\n");
    needAssets();
    needMarket();

    // Fresh approvals for replenishment
    const quoteNeeded = deployerQuoteForBids(REPLENISH_BIDS) * 2n;
    const baseNeeded = deployerBaseForAsks(REPLENISH_ASKS) * 2n;

    console.log(`Approving ${quoteNeeded} quote (tUSD) to market...`);
    castSend(quoteErc20, "approve(address,uint256)", `${marketAddress} ${quoteNeeded}`, DEPLOYER_KEY);
    console.log(`Approving ${baseNeeded} base (tNVDA) to market...`);
    castSend(baseErc20, "approve(address,uint256)", `${marketAddress} ${baseNeeded}`, DEPLOYER_KEY);

    const ZERO_BYTES32 = "0x0000000000000000000000000000000000000000000000000000000000000000";

    console.log("\nPlacing replenishment bids...");
    for (const { price, amount } of REPLENISH_BIDS) {
      const rawPrice = priceToRaw(price);
      const rawAmount = amount * BASE_UNIT;
      console.log(`  BID ${amount} tNVDA @ $${price}`);
      castSend(
        marketAddress,
        "placeLimitOrder(uint8,uint96,uint128,bytes32,bytes32,uint32,uint64)(uint32)",
        `0 ${rawPrice} ${rawAmount} ${ZERO_BYTES32} ${ZERO_BYTES32} 0 0`,
        DEPLOYER_KEY
      );
    }

    console.log("\nPlacing replenishment asks...");
    for (const { price, amount } of REPLENISH_ASKS) {
      const rawPrice = priceToRaw(price);
      const rawAmount = amount * BASE_UNIT;
      console.log(`  ASK ${amount} tNVDA @ $${price}`);
      castSend(
        marketAddress,
        "placeLimitOrder(uint8,uint96,uint128,bytes32,bytes32,uint32,uint64)(uint32)",
        `1 ${rawPrice} ${rawAmount} ${ZERO_BYTES32} ${ZERO_BYTES32} 0 0`,
        DEPLOYER_KEY
      );
    }

    console.log("\nOrder book replenished.");
  }

  // ─── Phase 6: Fund UI Trader ────────────────────────────
  if (shouldRun(6)) {
    console.log("\n=== Phase 6: Fund UI Trader (MetaMask) ===\n");
    needAssets();

    // Generate a fresh wallet for the UI user
    const walletOut = execSync("cast wallet new", { encoding: "utf8" }).trim();
    const addrMatch = walletOut.match(/Address:\s+(0x[0-9a-fA-F]{40})/);
    const keyMatch = walletOut.match(/Private key:\s+(0x[0-9a-fA-F]{64})/);
    if (!addrMatch || !keyMatch) throw new Error(`Failed to parse cast wallet new output:\n${walletOut}`);
    const uiAddr = addrMatch[1];
    const uiKey = keyMatch[1];

    // Fund with PAS
    console.log(`Funding UI trader ${uiAddr} with 5 PAS...`);
    const cmd = `cast send ${uiAddr} --rpc-url ${RPC_URL} --private-key ${DEPLOYER_KEY} --value 5000000000000000000`;
    execSync(cmd, { encoding: "utf8", timeout: 300_000 });

    // Transfer tokens via ERC20
    const uiQuote = 100_000n * QUOTE_UNIT; // 100K tUSD
    const uiBase = 1_000n * BASE_UNIT;     // 1K tNVDA

    console.log(`Sending ${uiQuote} tUSD to UI trader...`);
    castSend(quoteErc20, "transfer(address,uint256)", `${uiAddr} ${uiQuote}`, DEPLOYER_KEY);
    console.log(`Sending ${uiBase} tNVDA to UI trader...`);
    castSend(baseErc20, "transfer(address,uint256)", `${uiAddr} ${uiBase}`, DEPLOYER_KEY);

    console.log(`\n  ┌─────────────────────────────────────────┐`);
    console.log(`  │  UI Trader (import into MetaMask)        │`);
    console.log(`  │  Address: ${uiAddr}  │`);
    console.log(`  │  Key:     ${uiKey}  │`);
    console.log(`  │  Funded:  5 PAS + 100K tUSD + 1K tNVDA   │`);
    console.log(`  └─────────────────────────────────────────┘`);
  }

  // ─── Phase 7: Summary ───────────────────────────────────
  if (shouldRun(7)) {
    console.log("\n=== Phase 7: Summary ===\n");
    needAssets();
    needMarket();

    const bestPrices = cast(`call ${marketAddress} "getBestPrices()(uint96,uint96)"`);
    const totalOrders = cast(`call ${marketAddress} "nextOrderId()(uint32)"`);
    console.log(`Best prices (bid, ask): ${bestPrices}`);
    console.log(`Total orders placed: ${Number(totalOrders) - 1}`);

    const marketQuote = cast(`call ${quoteErc20} "balanceOf(address)(uint256)" ${marketAddress}`);
    const marketBase = cast(`call ${baseErc20} "balanceOf(address)(uint256)" ${marketAddress}`);
    console.log(`Market escrow — quote: ${marketQuote}, base: ${marketBase}`);

    console.log("\n════════════════════════════════════════════");
    console.log("    tNVDA/tUSD MARKET BOOTSTRAP COMPLETE    ");
    console.log("════════════════════════════════════════════\n");
    console.log(`  ${QUOTE_SYMBOL} Asset ID:     ${quoteId}`);
    console.log(`  ${QUOTE_SYMBOL} ERC20:        ${quoteErc20}`);
    console.log(`  ${BASE_SYMBOL} Asset ID:    ${baseId}`);
    console.log(`  ${BASE_SYMBOL} ERC20:       ${baseErc20}`);
    console.log(`  Factory:             ${FACTORY_ADDRESS}`);
    console.log(`  Market:              ${marketAddress}`);
    console.log(`  Trades executed:     ${PHASE4_SCRIPT.filter((s) => s.type === "trade").length}`);

    console.log("\n--- .env additions for resuming ---");
    console.log(`  NVDA_QUOTE_ASSET_ID=${quoteId}`);
    console.log(`  NVDA_BASE_ASSET_ID=${baseId}`);
    console.log(`  NVDA_MARKET_ADDRESS=${marketAddress}`);

    console.log("\n--- Update apps/trade/src/config/chains.ts ---");
    console.log(`  factoryAddress: "${FACTORY_ADDRESS}"  (same factory, new market auto-discovered)`);

    console.log("\n--- Next steps ---");
    console.log("1. cd apps/trade && pnpm dev");
    console.log("2. Select tNVDA/tUSD market in the UI");
    console.log("3. Chart should show ~11 candles with green/red price movement");
    console.log("4. Import UI trader key into MetaMask to trade\n");
  }
}

main().catch((err) => {
  console.error("\nError:", err.message || err);
  process.exit(1);
});
