// Creates two test assets on Asset Hub via @polkadot/api.
// Alice creates the quote token, Bob creates the base token, Charlie gets both.
//
// Requires: ALICE_SEED, BOB_SEED, CHARLIE_SEED, WSS_URL in scripts/.env
// Usage: source scripts/.env && node scripts/create-assets.mjs

import { ApiPromise, WsProvider, Keyring } from "@polkadot/api";

function requireEnv(name) {
  const val = process.env[name];
  if (!val) throw new Error(`Missing environment variable: ${name}`);
  return val;
}

const WS_ENDPOINT = requireEnv("WSS_URL");
const ALICE_URI = requireEnv("ALICE_SEED");
const BOB_URI = requireEnv("BOB_SEED");
const CHARLIE_URI = requireEnv("CHARLIE_SEED");

// Customize these for your token pair
const QUOTE_NAME = "Test Tether USD";
const QUOTE_SYMBOL = "tUSDT";
const QUOTE_DECIMALS = 6;
const QUOTE_SUPPLY_ALICE = 1_000_000_000_000n;    // 1M to Alice
const QUOTE_SUPPLY_CHARLIE = 500_000_000_000n;    // 500K to Charlie

const BASE_NAME = "Test Tether Gold";
const BASE_SYMBOL = "tXAUT";
const BASE_DECIMALS = 6;
const BASE_SUPPLY_BOB = 10_000_000_000n;           // 10,000 to Bob
const BASE_SUPPLY_CHARLIE = 5_000_000_000n;        // 5,000 to Charlie

async function main() {
  const provider = new WsProvider(WS_ENDPOINT);
  const api = await ApiPromise.create({
    provider,
    signedExtensions: {
      AuthorizeCall: { extrinsic: {}, payload: {} },
      EthSetOrigin: { extrinsic: {}, payload: {} },
      StorageWeightReclaim: { extrinsic: {}, payload: {} },
    },
  });

  const keyring = new Keyring({ type: "sr25519" });
  const alice = keyring.addFromUri(ALICE_URI);
  const bob = keyring.addFromUri(BOB_URI);
  const charlie = keyring.addFromUri(CHARLIE_URI);

  console.log("Alice:", alice.address);
  console.log("Bob:", bob.address);
  console.log("Charlie:", charlie.address);

  // Get next available asset ID (Asset Hub uses AutoIncAssetId)
  const nextId = (await api.query.assets.nextAssetId()).unwrap().toNumber();
  console.log("Next asset ID:", nextId);

  const quoteId = nextId;
  const baseId = nextId + 1;

  // --- Quote token: created by Alice ---
  console.log(`\nCreating ${QUOTE_SYMBOL} (asset ${quoteId}) with Alice...`);
  const quoteBatch = api.tx.utility.batchAll([
    api.tx.assets.create(quoteId, alice.address, 1),
    api.tx.assets.setMetadata(quoteId, QUOTE_NAME, QUOTE_SYMBOL, QUOTE_DECIMALS),
    api.tx.assets.mint(quoteId, alice.address, QUOTE_SUPPLY_ALICE),
    api.tx.assets.mint(quoteId, charlie.address, QUOTE_SUPPLY_CHARLIE),
  ]);

  await sendAndWait(quoteBatch, alice, `${QUOTE_SYMBOL} batch`);

  // --- Base token: created by Bob ---
  console.log(`\nCreating ${BASE_SYMBOL} (asset ${baseId}) with Bob...`);
  const baseBatch = api.tx.utility.batchAll([
    api.tx.assets.create(baseId, bob.address, 1),
    api.tx.assets.setMetadata(baseId, BASE_NAME, BASE_SYMBOL, BASE_DECIMALS),
    api.tx.assets.mint(baseId, bob.address, BASE_SUPPLY_BOB),
    api.tx.assets.mint(baseId, charlie.address, BASE_SUPPLY_CHARLIE),
  ]);

  await sendAndWait(baseBatch, bob, `${BASE_SYMBOL} batch`);

  // --- Verify ---
  console.log("\n========================================");
  console.log("         ASSET CREATION SUMMARY         ");
  console.log("========================================\n");

  for (const [label, id] of [[QUOTE_SYMBOL, quoteId], [BASE_SYMBOL, baseId]]) {
    const meta = await api.query.assets.metadata(id);
    const info = await api.query.assets.asset(id);
    const aliceBal = await api.query.assets.account(id, alice.address);
    const bobBal = await api.query.assets.account(id, bob.address);
    const charlieBal = await api.query.assets.account(id, charlie.address);

    console.log(`--- ${label} ---`);
    console.log(`  Asset ID:        ${id}`);
    console.log(`  Name:            ${meta.name.toUtf8()}`);
    console.log(`  Symbol:          ${meta.symbol.toUtf8()}`);
    console.log(`  Decimals:        ${meta.decimals}`);
    console.log(`  Total Supply:    ${info.unwrap().supply.toString()}`);
    console.log(`  ERC20 Address:   ${assetIdToErc20(id)}`);
    console.log(`  Alice balance:   ${aliceBal.isSome ? aliceBal.unwrap().balance.toString() : "0"}`);
    console.log(`  Bob balance:     ${bobBal.isSome ? bobBal.unwrap().balance.toString() : "0"}`);
    console.log(`  Charlie balance: ${charlieBal.isSome ? charlieBal.unwrap().balance.toString() : "0"}`);
    console.log();
  }

  console.log("Add these to your .env:");
  console.log(`  QUOTE_ASSET_ID="${quoteId}"`);
  console.log(`  QUOTE_ERC20="${assetIdToErc20(quoteId)}"`);
  console.log(`  QUOTE_DECIMALS="${QUOTE_DECIMALS}"`);
  console.log(`  BASE_ASSET_ID="${baseId}"`);
  console.log(`  BASE_ERC20="${assetIdToErc20(baseId)}"`);
  console.log(`  BASE_DECIMALS="${BASE_DECIMALS}"`);

  await api.disconnect();
}

function assetIdToErc20(assetId) {
  const idHex = assetId.toString(16).padStart(8, "0");
  return `0x${idHex}00000000000000000000000001200000`;
}

function sendAndWait(tx, signer, label) {
  return new Promise((resolve, reject) => {
    let resolved = false;
    tx.signAndSend(signer, ({ status, dispatchError }) => {
      if (status.isReady) console.log(`  ${label}: Ready (in tx pool)`);
      if (status.isBroadcast) console.log(`  ${label}: Broadcast`);
      if (status.isInBlock) {
        console.log(`  ${label}: Included in block ${status.asInBlock.toHex()}`);
        if (dispatchError) {
          if (dispatchError.isModule) {
            const decoded = tx.registry.findMetaError(dispatchError.asModule);
            reject(new Error(`${label} failed: ${decoded.section}.${decoded.name}: ${decoded.docs.join(" ")}`));
          } else {
            reject(new Error(`${label} failed: ${dispatchError.toString()}`));
          }
          return;
        }
        if (!resolved) {
          resolved = true;
          resolve();
        }
      }
      if (status.isFinalized) {
        console.log(`  ${label}: Finalized in ${status.asFinalized.toHex()}`);
      }
    }).catch(reject);
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
