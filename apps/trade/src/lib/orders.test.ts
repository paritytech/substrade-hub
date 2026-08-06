import { describe, it, expect } from "vitest";
import { isOpenOrder } from "./orders";

const OWNER = "0x2d7e83b2c28b2d72f34f2c87865fa8571030d9db";
const order = (
  over: Partial<{ status: number; price: bigint; remainingAmount: bigint; originAccount: string }> = {},
) => ({
  status: 0,
  price: 866n * 10n ** 18n,
  remainingAmount: 1_000_000n,
  originAccount: OWNER,
  ...over,
});

describe("isOpenOrder", () => {
  it("true for an active, partially-unfilled order owned by the account", () => {
    expect(isOpenOrder(order(), OWNER)).toBe(true);
  });

  it("false when fully filled (remainingAmount 0) even if status is still Active", () => {
    // Regression: the DLOB leaves a filled order's status Active, so it must be excluded by remaining.
    expect(isOpenOrder(order({ remainingAmount: 0n }), OWNER)).toBe(false);
  });

  it("false for a market-order ghost (price 0) even if it has a remainder", () => {
    // Market orders never rest; their lingering struct (price 0) must not show as an open order.
    expect(isOpenOrder(order({ price: 0n }), OWNER)).toBe(false);
  });

  it("false when not Active (cancelled/filled status)", () => {
    expect(isOpenOrder(order({ status: 1 }), OWNER)).toBe(false);
  });

  it("false for another account's order (case-insensitive match)", () => {
    expect(isOpenOrder(order(), "0xdeadbeef")).toBe(false);
    expect(isOpenOrder(order({ originAccount: OWNER.toUpperCase() }), OWNER)).toBe(true);
  });
});
