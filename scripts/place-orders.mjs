// Places two resting limit orders on the BRKB/FUSD market to test escrow.
// Mario (buyer): buy 10 BRKB @ 475 FUSD
// Luigi (seller): sell 5 BRKB @ 477 FUSD
//
// Step 1: Transfer assets from Substrate accounts (Alice→Mario, Bob→Luigi)
// Step 2: Fund Mario & Luigi with PAS for gas
// Step 3: EVM approve + placeLimitOrder
//
// Usage: source .env && node scripts/place-orders.mjs

import { ApiPromise, WsProvider, Keyring } from "@polkadot/api";
import { execSync } from "child_process";

function requireEnv(name) {
  const val = process.env[name];
  if (!val) throw new Error(`Missing environment variable: ${name}`);
  return val;
}

// --- Config from .env ---
const WSS_URL = requireEnv("WSS_URL");
const RPC_URL = requireEnv("RPC_URL");

const ALICE_SEED = requireEnv("ALICE_SEED");
const BOB_SEED = requireEnv("BOB_SEED");

const DEPLOYER_KEY = requireEnv("DEPLOYER_PRIVATE_KEY");
const MARIO_KEY = requireEnv("MARIO_PRIVATE_KEY");
const MARIO_ADDR = requireEnv("MARIO_ADDRESS");
const LUIGI_KEY = requireEnv("LUIGI_PRIVATE_KEY");
const LUIGI_ADDR = requireEnv("LUIGI_ADDRESS");

const MARKET = requireEnv("BRKB_FUSD_MARKET");
const FUSD_ERC20 = requireEnv("FUSD_ERC20");
const BRKB_ERC20 = requireEnv("BRKB_ERC20");
const FUSD_ASSET_ID = Number(requireEnv("FUSD_ASSET_ID"));
const BRKB_ASSET_ID = Number(requireEnv("BRKB_ASSET_ID"));

// Order params
// BRKB: 8 decimals, FUSD: 6 decimals, PRECISION: 1e18
// Price 475 FUSD/BRKB = 475 * 1e16 = 4.75e18
// Price 477 FUSD/BRKB = 477 * 1e16 = 4.77e18
const BUY_AMOUNT = 10n * 10n ** 8n;       // 10 BRKB in raw units
const BUY_PRICE = 475n * 10n ** 16n;       // 475 FUSD per BRKB
const SELL_AMOUNT = 5n * 10n ** 8n;        // 5 BRKB in raw units
const SELL_PRICE = 477n * 10n ** 16n;      // 477 FUSD per BRKB

// Escrow needed:
// Mario (buy): 10 BRKB * 475 FUSD = 4750 FUSD = 4750 * 1e6 = 4,750,000,000 raw
// Luigi (sell): 5 BRKB = 5 * 1e8 = 500,000,000 raw
const FUSD_TRANSFER = 5000n * 10n ** 6n;   // 5000 FUSD (extra buffer)
const BRKB_TRANSFER = 10n * 10n ** 8n;     // 10 BRKB (extra buffer)
const PAS_GAS_FUND = "50000000000000000000"; // 50 PAS in wei (18 decimals on EVM side)

function evmToSubstrate(evmAddr) {
  // Pad H160 with 0xEE to get AccountId32
  const addr = evmAddr.toLowerCase().replace("0x", "");
  return "0x" + addr + "ee".repeat(12);
}

function cast(args) {
  const cmd = `cast ${args} --rpc-url ${RPC_URL}`;
  console.log(`  > cast ${args.split(" ").slice(0, 3).join(" ")}...`);
  const result = execSync(cmd, { encoding: "utf8", timeout: 120000 }).trim();
  return result;
}

function castSend(to, sig, args, privateKey, value) {
  const valueFlag = value ? ` --value ${value}` : "";
  const cmd = `cast send ${to} "${sig}" ${args} --rpc-url ${RPC_URL} --private-key ${privateKey}${valueFlag}`;
  console.log(`  > cast send ... "${sig}"`);
  const result = execSync(cmd, { encoding: "utf8", timeout: 120000 }).trim();
  // Extract status
  const statusMatch = result.match(/status\s+(\d+)/);
  if (statusMatch && statusMatch[1] !== "1") {
    throw new Error(`Transaction failed! Full output:\n${result}`);
  }
  return result;
}

function sendAndWait(tx, signer, label) {
  return new Promise((resolve, reject) => {
    let resolved = false;
    tx.signAndSend(signer, ({ status, dispatchError }) => {
      if (status.isReady) console.log(`  ${label}: Ready`);
      if (status.isInBlock) {
        console.log(`  ${label}: Included in block ${status.asInBlock.toHex()}`);
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
    }).catch(reject);
  });
}

async function main() {
  console.log("=== Step 1: Transfer assets from Substrate accounts ===\n");

  const provider = new WsProvider(WSS_URL);
  const api = await ApiPromise.create({
    provider,
    signedExtensions: {
      AuthorizeCall: { extrinsic: {}, payload: {} },
      EthSetOrigin: { extrinsic: {}, payload: {} },
      StorageWeightReclaim: { extrinsic: {}, payload: {} },
    },
  });

  const keyring = new Keyring({ type: "sr25519" });
  const alice = keyring.addFromUri(ALICE_SEED);
  const bob = keyring.addFromUri(BOB_SEED);

  // Get Substrate AccountId32 for Mario and Luigi (0xEE padded)
  const marioSubstrate = evmToSubstrate(MARIO_ADDR);
  const luigiSubstrate = evmToSubstrate(LUIGI_ADDR);
  console.log("Mario Substrate (0xEE padded):", marioSubstrate);
  console.log("Luigi Substrate (0xEE padded):", luigiSubstrate);

  // Fund Mario and Luigi Substrate accounts with existential deposit (PAS)
  // so they can receive assets
  const ED = 1_000_000_000n; // 0.001 PAS (12 decimals on Substrate side)
  console.log("\nFunding Mario Substrate account with existential deposit...");
  const fundMario = api.tx.balances.transferKeepAlive(marioSubstrate, ED.toString());
  await sendAndWait(fundMario, alice, "Fund Mario ED");

  console.log("Funding Luigi Substrate account with existential deposit...");
  const fundLuigi = api.tx.balances.transferKeepAlive(luigiSubstrate, ED.toString());
  await sendAndWait(fundLuigi, bob, "Fund Luigi ED");

  // Alice transfers FUSD to Mario
  console.log(`\nAlice transferring ${FUSD_TRANSFER / 10n ** 6n} FUSD to Mario...`);
  const fusdTx = api.tx.assets.transfer(FUSD_ASSET_ID, marioSubstrate, FUSD_TRANSFER.toString());
  await sendAndWait(fusdTx, alice, "FUSD transfer");

  // Bob transfers BRKB to Luigi
  console.log(`Bob transferring ${BRKB_TRANSFER / 10n ** 8n} BRKB to Luigi...`);
  const brkbTx = api.tx.assets.transfer(BRKB_ASSET_ID, luigiSubstrate, BRKB_TRANSFER.toString());
  await sendAndWait(brkbTx, bob, "BRKB transfer");

  await api.disconnect();

  console.log("\n=== Step 2: Fund Mario & Luigi with PAS for gas ===\n");

  // Deployer sends PAS to Mario and Luigi
  console.log("Funding Mario with 50 PAS...");
  castSend(MARIO_ADDR, "fallback()", "", DEPLOYER_KEY, PAS_GAS_FUND);
  console.log("Funding Luigi with 50 PAS...");
  castSend(LUIGI_ADDR, "fallback()", "", DEPLOYER_KEY, PAS_GAS_FUND);

  // Verify balances
  console.log("\n--- Balances after funding ---");
  const marioFusd = cast(`call ${FUSD_ERC20} "balanceOf(address)(uint256)" ${MARIO_ADDR}`);
  const luigiBrkb = cast(`call ${BRKB_ERC20} "balanceOf(address)(uint256)" ${LUIGI_ADDR}`);
  const marioPas = cast(`balance ${MARIO_ADDR}`);
  const luigiPas = cast(`balance ${LUIGI_ADDR}`);
  console.log(`Mario: ${marioFusd} FUSD (raw), ${marioPas} PAS (wei)`);
  console.log(`Luigi: ${luigiBrkb} BRKB (raw), ${luigiPas} PAS (wei)`);

  console.log("\n=== Step 3: Approve tokens to market ===\n");

  // Mario approves FUSD to market
  console.log("Mario approving FUSD...");
  castSend(FUSD_ERC20, "approve(address,uint256)", `${MARKET} ${FUSD_TRANSFER}`, MARIO_KEY);

  // Luigi approves BRKB to market
  console.log("Luigi approving BRKB...");
  castSend(BRKB_ERC20, "approve(address,uint256)", `${MARKET} ${BRKB_TRANSFER}`, LUIGI_KEY);

  console.log("\n=== Step 4: Place limit orders ===\n");

  // Mario: Buy 10 BRKB @ 475 FUSD
  // placeLimitOrder(Side side, uint96 price, uint128 amount, bytes32 originAccount, bytes32 settlementAccount, uint32 destParaId, uint64 expireTimestamp)
  // Side.Buy = 0
  console.log("Mario placing BUY order: 10 BRKB @ 475 FUSD...");
  const buyResult = castSend(
    MARKET,
    "placeLimitOrder(uint8,uint96,uint128,bytes32,bytes32,uint32,uint64)(uint32)",
    `0 ${BUY_PRICE} ${BUY_AMOUNT} 0x0000000000000000000000000000000000000000000000000000000000000000 0x0000000000000000000000000000000000000000000000000000000000000000 0 0`,
    MARIO_KEY
  );
  console.log(buyResult);

  // Luigi: Sell 5 BRKB @ 477 FUSD
  // Side.Sell = 1
  console.log("\nLuigi placing SELL order: 5 BRKB @ 477 FUSD...");
  const sellResult = castSend(
    MARKET,
    "placeLimitOrder(uint8,uint96,uint128,bytes32,bytes32,uint32,uint64)(uint32)",
    `1 ${SELL_PRICE} ${SELL_AMOUNT} 0x0000000000000000000000000000000000000000000000000000000000000000 0x0000000000000000000000000000000000000000000000000000000000000000 0 0`,
    LUIGI_KEY
  );
  console.log(sellResult);

  console.log("\n=== Step 5: Verify order book ===\n");

  // Check best bid and ask
  const bestBid = cast(`call ${MARKET} "bestBid()(uint32)"`);
  const bestAsk = cast(`call ${MARKET} "bestAsk()(uint32)"`);
  const totalOrders = cast(`call ${MARKET} "nextOrderId()(uint32)"`);
  console.log("Best bid node:", bestBid);
  console.log("Best ask node:", bestAsk);
  console.log("Total orders placed:", Number(totalOrders) - 1);

  // Check escrow: market should hold the tokens
  const marketFusd = cast(`call ${FUSD_ERC20} "balanceOf(address)(uint256)" ${MARKET}`);
  const marketBrkb = cast(`call ${BRKB_ERC20} "balanceOf(address)(uint256)" ${MARKET}`);
  console.log(`\nMarket escrow:`);
  console.log(`  FUSD held: ${marketFusd} (expected: 4750000000 = 4,750 FUSD)`);
  console.log(`  BRKB held: ${marketBrkb} (expected: 500000000 = 5 BRKB)`);

  // Check Mario and Luigi remaining balances
  const marioFusdAfter = cast(`call ${FUSD_ERC20} "balanceOf(address)(uint256)" ${MARIO_ADDR}`);
  const luigiBrkbAfter = cast(`call ${BRKB_ERC20} "balanceOf(address)(uint256)" ${LUIGI_ADDR}`);
  console.log(`\nTrader balances after orders:`);
  console.log(`  Mario FUSD: ${marioFusdAfter} (escrowed 4,750 FUSD)`);
  console.log(`  Luigi BRKB: ${luigiBrkbAfter} (escrowed 5 BRKB)`);

  console.log("\nDone! Two resting orders on the book, no match (475 < 477).");
}

main().catch((err) => {
  console.error("\nError:", err.message);
  process.exit(1);
});
