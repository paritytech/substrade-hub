import { describe, it, expect } from "vitest";
import { isRevert, formatDispatchError } from "./revive";

describe("isRevert (ExecReturnValue flags)", () => {
  it("is false when the revert bit (bit 0) is clear", () => {
    expect(isRevert(0)).toBe(false);
    expect(isRevert(2)).toBe(false); // an unrelated flag bit set
  });

  it("is true when the revert bit is set", () => {
    expect(isRevert(1)).toBe(true);
    expect(isRevert(3)).toBe(true); // revert + another bit
  });
});

describe("formatDispatchError", () => {
  it("uses the error type (and nested value type) when present", () => {
    expect(formatDispatchError({ type: "Module", value: { type: "Token" } })).toBe(
      "Transaction failed: Module (Token)",
    );
  });

  it("uses just the type when there is no nested value type", () => {
    expect(formatDispatchError({ type: "BadOrigin" })).toBe("Transaction failed: BadOrigin");
  });

  it("falls back to JSON for unrecognised shapes", () => {
    expect(formatDispatchError({ foo: 1 })).toContain("Transaction failed:");
  });
});
