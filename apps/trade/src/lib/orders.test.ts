import { describe, it, expect } from "vitest";
import { expiryLabel, isExpired, isOpenOrder, orderExpiry } from "./orders";

const OWNER = "0x2d7e83b2c28b2d72f34f2c87865fa8571030d9db";
const H160 = "0xbbfa164356c66a791c4c5e2596fe5486594c6c68";
const ACCOUNT = { h160: H160, originAccount: OWNER };
const order = (
  over: Partial<{ owner: string; status: number; price: bigint; remainingAmount: bigint; originAccount: string }> = {},
) => ({
  owner: H160,
  status: 0,
  price: 866n * 10n ** 18n,
  remainingAmount: 1_000_000n,
  originAccount: OWNER,
  ...over,
});

describe("isOpenOrder", () => {
  it("true for an active, partially-unfilled order owned by the account", () => {
    expect(isOpenOrder(order(), ACCOUNT)).toBe(true);
  });

  it("false when fully filled (remainingAmount 0) even if status is still Active", () => {
    // Regression: the DLOB leaves a filled order's status Active, so it must be excluded by remaining.
    expect(isOpenOrder(order({ remainingAmount: 0n }), ACCOUNT)).toBe(false);
  });

  it("false for a market-order ghost (price 0) even if it has a remainder", () => {
    // Market orders never rest; their lingering struct (price 0) must not show as an open order.
    expect(isOpenOrder(order({ price: 0n }), ACCOUNT)).toBe(false);
  });

  it("false when not Active (cancelled/filled status)", () => {
    expect(isOpenOrder(order({ status: 1 }), ACCOUNT)).toBe(false);
  });

  it("false for another account's order (case-insensitive match)", () => {
    expect(isOpenOrder(order(), { ...ACCOUNT, originAccount: "0xdeadbeef" })).toBe(false);
    expect(isOpenOrder(order({ originAccount: OWNER.toUpperCase() }), ACCOUNT)).toBe(true);
  });

  it("false for an order sent by another account carrying this account's originAccount", () => {
    // originAccount is caller-supplied; only the sender can cancel, so such an order is not the user's.
    expect(isOpenOrder(order({ owner: "0x00000000000000000000000000000000000000aa" }), ACCOUNT)).toBe(false);
    expect(isOpenOrder(order({ owner: H160.toUpperCase() }), ACCOUNT)).toBe(true);
  });
});

describe("order expiry", () => {
  const now = 1_800_000_000_000; // ms
  const sec = BigInt(now / 1000);

  it("a limit order sent now expires 24 hours later", () => {
    expect(orderExpiry(now)).toBe(sec + 86_400n);
    expect(orderExpiry(now + 999)).toBe(sec + 86_400n);
  });

  it("an order expires at its expireTimestamp, as the contract counts it", () => {
    expect(isExpired(0n, now)).toBe(false);
    expect(isExpired(sec + 1n, now)).toBe(false);
    expect(isExpired(sec, now)).toBe(true);
    expect(isExpired(sec - 1n, now)).toBe(true);
  });

  it("labels the time left", () => {
    expect(expiryLabel(0n, now)).toBe("Never");
    expect(expiryLabel(sec, now)).toBe("Expired");
    expect(expiryLabel(sec + 86_400n, now)).toBe("in 24h 0m");
    expect(expiryLabel(sec + 3_600n + 59n * 60n, now)).toBe("in 1h 59m");
    expect(expiryLabel(sec + 59n * 60n + 30n, now)).toBe("in 59m");
    expect(expiryLabel(sec + 20n, now)).toBe("in 1m");
  });
});
