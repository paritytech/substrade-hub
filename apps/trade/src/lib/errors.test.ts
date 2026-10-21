import { describe, it, expect } from "vitest";
import { encodeErrorResult } from "viem";
import { extractRevertReason, revertError } from "./errors";
import { isEmptyRevert, UserFacingError } from "./user-errors";
import { erc20Abi } from "../abi/erc20";
import { dlobAbi } from "../abi/dlob";

/** Build a result whose `.value.data` is the given hex bytes (mirrors the dry-run shape). */
function reverted(hex: string) {
  const clean = hex.replace(/^0x/, "");
  const bytes = new Uint8Array(clean.match(/../g)?.map((h) => parseInt(h, 16)) ?? []);
  return { value: { data: bytes } };
}

/** Revert data for DLOB error `name` with no arguments, encoded from the contract's ABI. */
const dlobError = (name: string) => encodeErrorResult({ abi: dlobAbi, errorName: name as never });

describe("extractRevertReason", () => {
  it("decodes a DLOB custom-error selector to a friendly message (PostOnlyWouldCross)", () => {
    expect(dlobError("PostOnlyWouldCross")).toBe("0x7cf05fcb"); // keccak256("PostOnlyWouldCross()")[0:4], as on chain
    expect(extractRevertReason(reverted(dlobError("PostOnlyWouldCross")))).toMatch(/post-only order/);
  });

  it("decodes NoLiquidity and NotTickAligned to friendly messages", () => {
    expect(extractRevertReason(reverted(dlobError("NoLiquidity")))).toMatch(/No liquidity/i);
    expect(extractRevertReason(reverted(dlobError("NotTickAligned")))).toMatch(/tick size/i);
  });

  it("decodes a selector even when the caller passes an unrelated ABI (uses the shared error set)", () => {
    expect(extractRevertReason(reverted(dlobError("PostOnlyWouldCross")), erc20Abi)).toMatch(/post-only order/);
  });

  it("returns the string for a standard Error(string) revert", () => {
    const data = encodeErrorResult({
      abi: [{ type: "error", name: "Error", inputs: [{ type: "string" }] }],
      errorName: "Error",
      args: ["boom"],
    });
    expect(extractRevertReason(reverted(data))).toBe("boom");
  });

  it("hints at balance/allowance for an empty (reasonless) revert", () => {
    expect(extractRevertReason(reverted("0x"))).toMatch(/balance or allowance/i);
    expect(extractRevertReason({ value: { data: undefined } })).toMatch(/balance or allowance/i);
  });

  it("surfaces the raw selector for an unknown error", () => {
    expect(extractRevertReason(reverted("0xdeadbeef"))).toContain("0xdeadbeef");
  });

  it("falls back to ErrorName(args) for a known error with no friendly mapping", () => {
    // AlreadyInitialized() — a real DLOB error with no FRIENDLY entry.
    expect(extractRevertReason(reverted(dlobError("AlreadyInitialized")))).toBe("AlreadyInitialized()");
  });
});

describe("revertError", () => {
  it("recognises a custom error that takes arguments", () => {
    // SafeERC20FailedOperation(address) = 0x5274afe7, then one address word.
    const data = `0x5274afe7${"00".repeat(12)}${"11".repeat(20)}`;
    expect(revertError(reverted(data)).message).toMatch(/Token transfer failed/);
  });

  const encoded = (name: string, args: unknown[]) =>
    encodeErrorResult({ abi: erc20Abi, errorName: name as never, args: args as never });

  it("gives a recognised contract error its friendly text", () => {
    const err = revertError(reverted(dlobError("PostOnlyWouldCross")));
    expect(err).toBeInstanceOf(UserFacingError);
    expect(err.message).toMatch(/post-only order/);
  });

  it("names a missing or too-low token approval, and too little token balance", () => {
    const spender = "0x0000000000000000000000000000000000000001";
    expect(revertError(reverted(encoded("ERC20InsufficientAllowance", [spender, 1n, 2n]))).message).toMatch(
      /approval is too low/,
    );
    expect(revertError(reverted(encoded("ERC20InsufficientBalance", [spender, 1n, 2n]))).message).toMatch(
      /Not enough token balance/,
    );
  });

  it("explains a halted market", () => {
    expect(revertError(reverted(dlobError("Halted"))).message).toMatch(/Trading is paused/);
  });

  it("marks a revert with no reason, so the caller can give the likely cause", () => {
    const err = revertError(reverted("0x"));
    expect(err.message).toBe("The contract rejected this transaction");
    expect(isEmptyRevert(err)).toBe(true);
    expect(isEmptyRevert(revertError(reverted(dlobError("PostOnlyWouldCross"))))).toBe(false);
  });

  it("shows no selector, error name or arguments for a revert it has no text for", () => {
    const unknown = revertError(reverted("0xdeadbeef"));
    expect(unknown.message).toBe("The contract rejected this transaction");
    expect(unknown.cause).toContain("0xdeadbeef"); // kept for the console
    expect(revertError(reverted(dlobError("AlreadyInitialized"))).message).toBe("The contract rejected this transaction");
  });
});
