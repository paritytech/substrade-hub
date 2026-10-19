import { describe, expect, it, vi } from "vitest";
import { encodeErrorResult } from "viem";
import { dlobAbi } from "../abi/dlob";

const { ethTransact } = vi.hoisted(() => ({ ethTransact: vi.fn() }));
vi.mock("./client", () => ({ getTypedApi: () => ({ apis: { ReviveApi: { eth_transact: ethTransact } } }) }));

import { readContract, simulateContract } from "./contract";
import { UserFacingError } from "./user-errors";

const MARKET = "0x00000000000000000000000000000000000000b1" as const;
const bytes = (hex: string) => new Uint8Array(hex.slice(2).match(/../g)!.map((h) => parseInt(h, 16)));

describe("eth_transact reverts", () => {
  // The shape ReviveApi.eth_transact returns for a revert, as observed on paseo-v2.
  const reverting = (name: string) => ({
    success: false,
    value: { type: "Data", value: bytes(encodeErrorResult({ abi: dlobAbi, errorName: name as never })) },
  });

  it("decodes the revert of a simulated write", async () => {
    ethTransact.mockResolvedValue(reverting("SlippageExceeded"));
    const args = [0, 1n, 1n, 0n, `0x${"00".repeat(32)}`, `0x${"00".repeat(32)}`, 0] as const;
    const err = await simulateContract(dlobAbi, "placeMarketOrder", args, MARKET, MARKET).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UserFacingError);
    expect((err as Error).message).toMatch(/Price moved too far/);
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
