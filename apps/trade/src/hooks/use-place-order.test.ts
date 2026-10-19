import { describe, expect, it, vi } from "vitest";
import { encodeAbiParameters } from "viem";

const { simulateContractData } = vi.hoisted(() => ({ simulateContractData: vi.fn() }));
vi.mock("../lib/contract", () => ({ simulateContractData }));

import { limitOrderReturned } from "./use-place-order";

const MARKET = "0x00000000000000000000000000000000000000aa";
const FROM = "0x00000000000000000000000000000000000000bb";
const ZERO = `0x${"00".repeat(32)}` as const;
const ARGS = [0, 10n ** 18n, 10n ** 6n, ZERO, ZERO, 0, 0n] as const;

describe("limitOrderReturned", () => {
  it("reads what the match budget returns", async () => {
    simulateContractData.mockResolvedValueOnce(encodeAbiParameters([{ type: "uint32" }, { type: "uint128" }], [7, 4n]));
    expect(await limitOrderReturned(ARGS, MARKET, FROM)).toBe(4n);
  });

  it("is 0 when the whole order fills or rests", async () => {
    simulateContractData.mockResolvedValueOnce(encodeAbiParameters([{ type: "uint32" }, { type: "uint128" }], [7, 0n]));
    expect(await limitOrderReturned(ARGS, MARKET, FROM)).toBe(0n);
  });

  it("is 0 on a market that returns only the order id", async () => {
    simulateContractData.mockResolvedValueOnce(encodeAbiParameters([{ type: "uint32" }], [7]));
    expect(await limitOrderReturned(ARGS, MARKET, FROM)).toBe(0n);
  });

  it("passes a failed simulation on", async () => {
    simulateContractData.mockRejectedValueOnce(new Error("reverted"));
    await expect(limitOrderReturned(ARGS, MARKET, FROM)).rejects.toThrow("reverted");
  });
});
