/**
 * Diagnostic + unblock: place a Substrate limit order using a PAPI-NATIVE signer (seed-derived),
 * bypassing the wallet extension / pjs-signer bridge. Uses the exact same tx-construction code as the
 * UI (`submitReviveCall`), so this isolates whether `BadProof` is our fault or the wallet bridge's:
 *   - succeeds  -> our command/tx-build is correct; the blocker is purely pjs-signer/wallets.
 *   - BadProof  -> it's our tx construction (then check stale metadata / custom signed-extensions).
 *
 * TESTNET ONLY. Never commit a seed; pass it via env. Run:
 *   SUBSTRATE_SEED="<paseo testnet mnemonic>" MARKET=0x… BASE=0x… \
 *     pnpm --filter @substrade-hub/trade exec tsx scripts/substrate-order.ts
 */
import { AccountId } from "polkadot-api";
import { getPolkadotSigner } from "polkadot-api/signer";
import { sr25519CreateDerive } from "@polkadot-labs/hdkd";
import { entropyToMiniSecret, mnemonicToEntropy } from "@polkadot-labs/hdkd-helpers";
import { encodeFunctionData } from "viem";

import { getClient } from "../src/lib/client";
import { submitReviveCall, ensureMapped } from "../src/lib/revive";
import { readContract } from "../src/lib/contract";
import { ss58ToOriginAccount, accountToH160 } from "../src/lib/account";
import { dlobAbi } from "../src/abi/dlob";
import { erc20Abi } from "../src/abi/erc20";
import { Side } from "../src/types/market";

// Grab MARKET + BASE from the market selector in the UI (or factory.getMarket). A limit SELL escrows
// exactly AMOUNT of the BASE token, so the account must hold that BASE balance to rest on the book.
const MARKET = (process.env.MARKET ?? "0x0000000000000000000000000000000000000000") as `0x${string}`;
const BASE = (process.env.BASE ?? "0x0000000000000000000000000000000000000000") as `0x${string}`;
const PRICE = BigInt(process.env.PRICE ?? "175000000000000000000"); // 18-dp price (e.g. $175.00)
const AMOUNT = BigInt(process.env.AMOUNT ?? "1000000"); // BASE amount, base-token decimals
const ZERO32 = ("0x" + "00".repeat(32)) as `0x${string}`;

async function main() {
  const seed = process.env.SUBSTRATE_SEED;
  if (!seed) throw new Error("Set SUBSTRATE_SEED (a testnet mnemonic) in the env");
  if (MARKET.endsWith("0000000000") || BASE.endsWith("0000000000"))
    throw new Error("Set MARKET and BASE env vars to a real market + base-token address");

  // 1. Native signer from the seed — builds the extrinsic from live metadata (handles any tx
  //    extension, incl. AuthorizeValueTransfer). No wallet, no pjs-signer legacy bridge.
  const keypair = sr25519CreateDerive(entropyToMiniSecret(mnemonicToEntropy(seed)))("");
  const signer = getPolkadotSigner(keypair.publicKey, "Sr25519", keypair.sign);
  const ss58 = AccountId().dec(keypair.publicKey);

  // 2. Same identities the UI derives.
  const originAccount = ss58ToOriginAccount(ss58); // 32-byte pubkey (self-trade param)
  const h160 = await accountToH160(ss58); // ReviveApi.address (msg.sender / reads owner)
  console.log("account:", { ss58, h160, originAccount });

  // 3. Map (near no-op on Asset Hub AutoMap), approve the base token, then place a limit SELL.
  console.log("ensureMapped…");
  await ensureMapped(h160, signer);

  console.log("approve(base, AMOUNT)…");
  await submitReviveCall({
    abi: erc20Abi,
    contractAddress: BASE,
    originSs58: ss58,
    signer,
    callData: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [MARKET, AMOUNT] }),
  });

  console.log("placeLimitOrder(SELL)…");
  const res = await submitReviveCall({
    abi: dlobAbi,
    contractAddress: MARKET,
    originSs58: ss58,
    signer,
    callData: encodeFunctionData({
      abi: dlobAbi,
      functionName: "placeLimitOrder",
      args: [Side.Sell, PRICE, AMOUNT, originAccount, ZERO32, 0, 0n],
    }),
  });
  console.log("placed, txHash:", res.txHash);

  // 4. Read the ask side back so we can confirm it rested (and that it shows in the UI's book too).
  const [prices, amounts] = (await readContract(
    dlobAbi,
    "getOrderBook",
    [1, 5], // side=1 (Sell/asks), top 5 levels
    MARKET,
  )) as [bigint[], bigint[], number];
  console.log(
    "ask levels:",
    prices.map((p, i) => `${p} x ${amounts[i]}`),
  );
}

main()
  .then(() => console.log("OK"))
  .catch((e) => {
    console.error("FAILED:", e instanceof Error ? e.message : e);
    process.exitCode = 1;
  })
  .finally(() => getClient().destroy());
