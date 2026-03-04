// Creates FUSD and BRKB assets on Asset Hub via @polkadot/api
// Requires: ALICE_SEED, BOB_SEED, CHARLIE_SEED, WSS_URL in .env
//
// Usage: source .env && node scripts/create-assets.mjs

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

  // Get next available asset ID
  const nextId = (await api.query.assets.nextAssetId()).unwrap().toNumber();
  console.log("Next asset ID:", nextId);

  const fusdId = nextId;
  const brkbId = nextId + 1;

  // --- FUSD: created by Alice (Alice keeps it, Charlie gets some) ---
  console.log(`\nCreating FUSD (asset ${fusdId}) with Alice...`);
  const fusdBatch = api.tx.utility.batchAll([
    api.tx.assets.create(fusdId, alice.address, 1),
    api.tx.assets.setMetadata(fusdId, "Fake USD", "FUSD", 6),
    api.tx.assets.mint(fusdId, alice.address, 1_000_000_000_000n),   // 1M FUSD to Alice
    api.tx.assets.mint(fusdId, charlie.address, 500_000_000_000n),   // 500K FUSD to Charlie
  ]);

  await sendAndWait(fusdBatch, alice, "FUSD batch");

  // --- BRKB: created by Bob (Bob keeps it, Charlie gets some) ---
  console.log(`\nCreating BRKB (asset ${brkbId}) with Bob...`);
  const brkbBatch = api.tx.utility.batchAll([
    api.tx.assets.create(brkbId, bob.address, 1),
    api.tx.assets.setMetadata(brkbId, "Berkshire Hathaway B", "BRKB", 8),
    api.tx.assets.mint(brkbId, bob.address, 100_000_000_000n),       // 1,000 BRKB to Bob
    api.tx.assets.mint(brkbId, charlie.address, 50_000_000_000n),    // 500 BRKB to Charlie
  ]);

  await sendAndWait(brkbBatch, bob, "BRKB batch");

  // --- Verify ---
  console.log("\n========================================");
  console.log("         ASSET CREATION SUMMARY         ");
  console.log("========================================\n");

  for (const [label, id] of [["FUSD", fusdId], ["BRKB", brkbId]]) {
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
