import { describe, expect, it, vi } from "vitest";
import { encodeErrorResult } from "viem";
import { dlobAbi } from "../abi/dlob";

const { ethTransact, reviveCall } = vi.hoisted(() => ({ ethTransact: vi.fn(), reviveCall: vi.fn() }));
vi.mock("./client", () => ({
  getTypedApi: () => ({
    apis: { ReviveApi: { eth_transact: ethTransact, call: reviveCall } },
    // paseo-v2's per-extrinsic limit.
    constants: {
      System: {
        BlockWeights: async () => ({
          max_block: { ref_time: 2_000_000_000_000n, proof_size: 10_485_760n },
          per_class: { normal: { max_extrinsic: { ref_time: 1_599_875_000_000n, proof_size: 8_388_608n } } },
        }),
      },
    },
  }),
}));

import { readContract, simulateContract } from "./contract";
import { UserFacingError } from "./user-errors";

const MARKET = "0x00000000000000000000000000000000000000b1" as const;
const bytes = (hex: string) => new Uint8Array((hex.slice(2).match(/../g) ?? []).map((h) => parseInt(h, 16)));

describe("eth_transact reverts", () => {
  // The shape ReviveApi.eth_transact returns for a revert, as observed on paseo-v2.
  const reverting = (name: string) => ({
    success: false,
    value: { type: "Data", value: bytes(encodeErrorResult({ abi: dlobAbi, errorName: name as never })) },
  });

  /** A ReviveApi.call dry run that reverts with `data` after needing `proof_size` of proof. */
  const dryRevert = (data: string, proof_size: bigint) => ({
    result: { success: true, value: { flags: 1, data: bytes(data) } },
    weight_required: { ref_time: 20_000_000_000n, proof_size },
    storage_deposit: { type: "Refund", value: 0n },
  });
  const marketArgs = [0, 1n, 1n, 0n, `0x${"00".repeat(32)}`, `0x${"00".repeat(32)}`, 0] as const;

  it("decodes the revert of a simulated write", async () => {
    reviveCall.mockResolvedValue(dryRevert(encodeErrorResult({ abi: dlobAbi, errorName: "SlippageExceeded" as never }), 1_800_000n));
    const err = await simulateContract(dlobAbi, "placeMarketOrder", marketArgs, MARKET, MARKET).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UserFacingError);
    expect((err as Error).message).toMatch(/Price moved too far/);
  });

  it("reports a simulated order that ran out of proof as too large, not as a revert", async () => {
    // A 12-level sweep on paseo-v2: it reverts with no reason after using up the block's proof.
    reviveCall.mockResolvedValue(dryRevert("0x", 10_478_239n));
    await expect(simulateContract(dlobAbi, "placeMarketOrder", marketArgs, MARKET, MARKET)).rejects.toThrow(
      /crosses too many price levels/,
    );
  });

  it("decodes the revert of a read", async () => {
    ethTransact.mockResolvedValue(reverting("NotTickAligned"));
    await expect(readContract(dlobAbi, "nextOrderId", [], MARKET)).rejects.toThrow(/tick size/);
  });

  it("keeps a failure outside the contract internal", async () => {
    ethTransact.mockResolvedValue({ success: false, value: { type: "Message", value: "insufficient funds for gas" } });
    const err = await readContract(dlobAbi, "nextOrderId", [], MARKET).catch((e: unknown) => e);
    expect(err).not.toBeInstanceOf(UserFacingError);
  });
});
