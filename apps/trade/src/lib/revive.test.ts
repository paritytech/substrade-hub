import { describe, it, expect } from "vitest";
import { isRevert, formatSubmitError } from "./revive";

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

describe("formatSubmitError", () => {
  it("uses the error type (and nested value type) when present", () => {
    expect(formatSubmitError({ type: "Module", value: { type: "Token" } })).toBe(
      "Transaction failed: Module (Token)",
    );
  });

  it("uses just the type when there is no nested value type", () => {
    expect(formatSubmitError({ type: "BadOrigin" })).toBe("Transaction failed: BadOrigin");
  });

  it("gives a signature-specific hint for BadProof (not a balance error)", () => {
    const msg = formatSubmitError({ type: "Invalid", value: { type: "BadProof" } });
    expect(msg).toMatch(/BadProof/);
    expect(msg).toMatch(/not an insufficient-balance/i);
  });

  it("unwraps a PAPI `.error` wrapper", () => {
    expect(formatSubmitError({ error: { type: "Invalid", value: { type: "BadProof" } } })).toMatch(
      /BadProof/,
    );
  });

  it("parses an Error whose message JSON-encodes the shape", () => {
    const err = new Error(JSON.stringify({ type: "Invalid", value: { type: "Stale" } }));
    expect(formatSubmitError(err)).toBe("Transaction failed: Invalid (Stale)");
  });

  it("passes through a plain Error message unchanged", () => {
    expect(formatSubmitError(new Error("map_account failed: x"))).toBe("map_account failed: x");
  });

  it("falls back to JSON for unrecognised shapes", () => {
    expect(formatSubmitError({ foo: 1 })).toContain("Transaction failed:");
  });
});
