import { describe, it, expect } from "vitest";
import { encodeErrorResult } from "viem";
import { extractRevertReason } from "./errors";
import { erc20Abi } from "../abi/erc20";

/** Build a result whose `.value.data` is the given hex bytes (mirrors the dry-run shape). */
function reverted(hex: string) {
  const clean = hex.replace(/^0x/, "");
  const bytes = new Uint8Array(clean.match(/../g)?.map((h) => parseInt(h, 16)) ?? []);
  return { value: { data: bytes } };
}

describe("extractRevertReason", () => {
  it("decodes a DLOB custom-error selector to a friendly message (SelfTrade)", () => {
    // SelfTrade() has no args, so the revert data is just its 4-byte selector.
    expect(extractRevertReason(reverted("0xdccbe31a"))).toMatch(/own resting order/);
  });

  it("decodes NoLiquidity and NotTickAligned to friendly messages", () => {
    expect(extractRevertReason(reverted("0xfa27e76e"))).toMatch(/No liquidity/i);
    expect(extractRevertReason(reverted("0x66e09afc"))).toMatch(/tick size/i);
  });

  it("decodes a selector even when the caller passes an unrelated ABI (uses the shared error set)", () => {
    expect(extractRevertReason(reverted("0xdccbe31a"), erc20Abi)).toMatch(/own resting order/);
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
    // AlreadyInitialized() = 0xeb0dd890 — a real DLOB error with no FRIENDLY entry.
    expect(extractRevertReason(reverted("0xeb0dd890"))).toBe("AlreadyInitialized()");
  });
});
