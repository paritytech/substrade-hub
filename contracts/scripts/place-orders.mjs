// Places two resting limit orders on a market to test escrow.
// Mario (buyer): buy base tokens with quote tokens
// Luigi (seller): sell base tokens for quote tokens
//
// Step 1: Transfer assets from Substrate accounts (Alice→Mario, Bob→Luigi)
// Step 2: Fund Mario & Luigi with native token for gas
// Step 3: EVM approve + placeLimitOrder
//
// Requires all env vars from scripts/.env (see scripts/.env.example)
// Usage: source scripts/.env && node scripts/place-orders.mjs

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

const MARKET = requireEnv("MARKET_ADDRESS");
const QUOTE_ERC20 = requireEnv("QUOTE_ERC20");
const BASE_ERC20 = requireEnv("BASE_ERC20");
const QUOTE_ASSET_ID = Number(requireEnv("QUOTE_ASSET_ID"));
const BASE_ASSET_ID = Number(requireEnv("BASE_ASSET_ID"));
const QUOTE_DECIMALS = Number(requireEnv("QUOTE_DECIMALS"));
const BASE_DECIMALS = Number(requireEnv("BASE_DECIMALS"));

// --- Order params (customize for your market) ---
// Price uses 18-decimal fixed-point: price * 10^(18 - quoteDecimals + baseDecimals)
// Example: base=8 decimals, quote=6 decimals → price 475 = 475 * 1e16
const BUY_PRICE = 475n * 10n ** 16n;
const BUY_AMOUNT = 10n * 10n ** BigInt(BASE_DECIMALS);
const SELL_PRICE = 477n * 10n ** 16n;
const SELL_AMOUNT = 5n * 10n ** BigInt(BASE_DECIMALS);

// Transfer amounts (with buffer above escrow needs)
const QUOTE_TRANSFER = 5000n * 10n ** BigInt(QUOTE_DECIMALS);
const BASE_TRANSFER = 10n * 10n ** BigInt(BASE_DECIMALS);
const GAS_FUND = "50000000000000000000"; // 50 native tokens in wei (18 decimals on EVM side)

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

  // Fund Mario and Luigi Substrate accounts with existential deposit
  // so they can receive assets
  const ED = 1_000_000_000n; // 0.001 native token (12 decimals on Substrate side)
  console.log("\nFunding Mario Substrate account with existential deposit...");
  const fundMario = api.tx.balances.transferKeepAlive(marioSubstrate, ED.toString());
  await sendAndWait(fundMario, alice, "Fund Mario ED");

  console.log("Funding Luigi Substrate account with existential deposit...");
  const fundLuigi = api.tx.balances.transferKeepAlive(luigiSubstrate, ED.toString());
  await sendAndWait(fundLuigi, bob, "Fund Luigi ED");

  // Alice transfers quote tokens to Mario (buyer needs quote to bid)
  console.log(`\nAlice transferring quote tokens to Mario...`);
  const quoteTx = api.tx.assets.transfer(QUOTE_ASSET_ID, marioSubstrate, QUOTE_TRANSFER.toString());
  await sendAndWait(quoteTx, alice, "Quote transfer");

  // Bob transfers base tokens to Luigi (seller needs base to ask)
  console.log(`Bob transferring base tokens to Luigi...`);
  const baseTx = api.tx.assets.transfer(BASE_ASSET_ID, luigiSubstrate, BASE_TRANSFER.toString());
  await sendAndWait(baseTx, bob, "Base transfer");

  await api.disconnect();

  console.log("\n=== Step 2: Fund Mario & Luigi with native token for gas ===\n");

  // Deployer sends native token to Mario and Luigi
  console.log("Funding Mario...");
  castSend(MARIO_ADDR, "fallback()", "", DEPLOYER_KEY, GAS_FUND);
  console.log("Funding Luigi...");
  castSend(LUIGI_ADDR, "fallback()", "", DEPLOYER_KEY, GAS_FUND);

  // Verify balances
  console.log("\n--- Balances after funding ---");
  const marioQuote = cast(`call ${QUOTE_ERC20} "balanceOf(address)(uint256)" ${MARIO_ADDR}`);
  const luigiBase = cast(`call ${BASE_ERC20} "balanceOf(address)(uint256)" ${LUIGI_ADDR}`);
  const marioBal = cast(`balance ${MARIO_ADDR}`);
  const luigiBal = cast(`balance ${LUIGI_ADDR}`);
  console.log(`Mario: ${marioQuote} quote (raw), ${marioBal} native (wei)`);
  console.log(`Luigi: ${luigiBase} base (raw), ${luigiBal} native (wei)`);

  console.log("\n=== Step 3: Approve tokens to market ===\n");

  // Mario approves quote token to market
  console.log("Mario approving quote token...");
  castSend(QUOTE_ERC20, "approve(address,uint256)", `${MARKET} ${QUOTE_TRANSFER}`, MARIO_KEY);

  // Luigi approves base token to market
  console.log("Luigi approving base token...");
  castSend(BASE_ERC20, "approve(address,uint256)", `${MARKET} ${BASE_TRANSFER}`, LUIGI_KEY);

  console.log("\n=== Step 4: Place limit orders ===\n");

  // Mario: Buy base @ BUY_PRICE
  // placeLimitOrder(Side, uint96 price, uint128 amount, bytes32 originAccount, bytes32 settlementAccount, uint32 destParaId, uint64 expireTimestamp)
  // Side.Buy = 0
  console.log(`Mario placing BUY order: ${BUY_AMOUNT} base @ ${BUY_PRICE} ...`);
  const ZERO_BYTES32 = "0x0000000000000000000000000000000000000000000000000000000000000000";
  const buyResult = castSend(
    MARKET,
    "placeLimitOrder(uint8,uint96,uint128,bytes32,bytes32,uint32,uint64)(uint32)",
    `0 ${BUY_PRICE} ${BUY_AMOUNT} ${ZERO_BYTES32} ${ZERO_BYTES32} 0 0`,
    MARIO_KEY
  );
  console.log(buyResult);

  // Luigi: Sell base @ SELL_PRICE
  // Side.Sell = 1
  console.log(`\nLuigi placing SELL order: ${SELL_AMOUNT} base @ ${SELL_PRICE} ...`);
  const sellResult = castSend(
    MARKET,
    "placeLimitOrder(uint8,uint96,uint128,bytes32,bytes32,uint32,uint64)(uint32)",
    `1 ${SELL_PRICE} ${SELL_AMOUNT} ${ZERO_BYTES32} ${ZERO_BYTES32} 0 0`,
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
  const marketQuote = cast(`call ${QUOTE_ERC20} "balanceOf(address)(uint256)" ${MARKET}`);
  const marketBase = cast(`call ${BASE_ERC20} "balanceOf(address)(uint256)" ${MARKET}`);
  console.log(`\nMarket escrow:`);
  console.log(`  Quote held: ${marketQuote}`);
  console.log(`  Base held:  ${marketBase}`);

  // Check Mario and Luigi remaining balances
  const marioQuoteAfter = cast(`call ${QUOTE_ERC20} "balanceOf(address)(uint256)" ${MARIO_ADDR}`);
  const luigiBaseAfter = cast(`call ${BASE_ERC20} "balanceOf(address)(uint256)" ${LUIGI_ADDR}`);
  console.log(`\nTrader balances after orders:`);
  console.log(`  Mario quote: ${marioQuoteAfter}`);
  console.log(`  Luigi base:  ${luigiBaseAfter}`);

  console.log("\nDone! Two resting orders on the book (bid < ask, no match).");
}

main().catch((err) => {
  console.error("\nError:", err.message);
  process.exit(1);
});
