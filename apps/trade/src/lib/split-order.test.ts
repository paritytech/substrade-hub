import { describe, expect, it, vi } from "vitest";
import { MAX_PARTS, PartFailedError, placeInParts, TooManyPartsError, type PartOutcome } from "./split-order";

/** Steps whose simulation answers from `outcomes` in turn, recording each part sent. */
function steps(outcomes: PartOutcome[], opts: { amount?: bigint; min?: bigint; confirm?: boolean; failAt?: number } = {}) {
  const sent: Array<{ size: bigint; part: number; of: number; outcome: string }> = [];
  const simulate = vi.fn(async () => outcomes.shift() ?? { kind: "whole" as const });
  const confirm = vi.fn(async () => opts.confirm ?? true);
  const send = vi.fn(async (size: bigint, part: number, of: number, outcome: string) => {
    if (part === opts.failAt) throw new Error("rejected");
    sent.push({ size, part, of, outcome });
  });
  return { sent, simulate, confirm, send, amount: opts.amount ?? 100n, minOrderSize: opts.min ?? 10n };
}

describe("placeInParts", () => {
  it("sends an order that fits in one transaction without asking", async () => {
    const s = steps([{ kind: "whole" }]);
    expect(await placeInParts(s)).toEqual({ status: "done", sent: 1, final: "whole" });
    expect(s.confirm).not.toHaveBeenCalled();
    expect(s.sent).toEqual([{ size: 100n, part: 1, of: 1, outcome: "whole" }]);
  });

  it("asks once, then sends parts sized to each simulation until one takes the rest", async () => {
    const s = steps([{ kind: "part", fills: 40n }, { kind: "part", fills: 40n }, { kind: "whole" }]);
    expect(await placeInParts(s)).toEqual({ status: "done", sent: 3, final: "whole" });
    expect(s.confirm).toHaveBeenCalledWith(3);
    expect(s.simulate.mock.calls.map((c) => (c as unknown[])[0])).toEqual([100n, 60n, 20n]);
    expect(s.sent.map((p) => [p.size, p.part, p.of])).toEqual([[40n, 1, 3], [40n, 2, 3], [20n, 3, 3]]);
  });

  it("raises the estimate when the book fills less than expected", async () => {
    const s = steps([{ kind: "part", fills: 50n }, { kind: "part", fills: 20n }, { kind: "part", fills: 20n }, { kind: "whole" }]);
    await placeInParts(s);
    expect(s.sent.map((p) => p.of)).toEqual([2, 4, 4, 4]);
  });

  it("sends nothing when the user declines", async () => {
    const s = steps([{ kind: "part", fills: 40n }], { confirm: false });
    expect(await placeInParts(s)).toEqual({ status: "cancelled" });
    expect(s.send).not.toHaveBeenCalled();
  });

  it("refuses an order that needs more than MAX_PARTS transactions before sending anything", async () => {
    const s = steps([{ kind: "part", fills: 9n }]);
    await expect(placeInParts(s)).rejects.toEqual(new TooManyPartsError(9n));
    expect(s.confirm).not.toHaveBeenCalled();
  });

  it("stops when the book within the price runs out", async () => {
    const s = steps([{ kind: "part", fills: 40n }, { kind: "none" }]);
    expect(await placeInParts(s)).toEqual({ status: "dry", sent: 1, remaining: 60n });
    expect(await placeInParts(steps([{ kind: "none" }]))).toEqual({ status: "dry", sent: 0, remaining: 100n });
  });

  it("ends after a part that only clears the front of the book", async () => {
    const s = steps([{ kind: "part", fills: 40n }, { kind: "clears" }]);
    expect(await placeInParts(s)).toEqual({ status: "done", sent: 2, final: "clears" });
    expect(s.sent[1]).toMatchObject({ size: 60n, outcome: "clears" });
  });

  it("stops when what is left is below the minimum order size", async () => {
    const s = steps([{ kind: "part", fills: 95n }], { min: 10n });
    expect(await placeInParts(s)).toEqual({ status: "dust", sent: 1, remaining: 5n });
  });

  it("stops after MAX_PARTS transactions when the book keeps filling less", async () => {
    // The first simulation says 10 parts; later ones fill less, and the order stops at the cap.
    const s = steps([{ kind: "part", fills: 100n }, ...Array.from({ length: 20 }, () => ({ kind: "part" as const, fills: 10n }))], {
      amount: 1000n,
      min: 1n,
    });
    expect(await placeInParts(s)).toEqual({ status: "capped", sent: MAX_PARTS, remaining: 810n });
  });

  it("passes a first failure on as is, and a later one with what went through", async () => {
    await expect(placeInParts(steps([{ kind: "whole" }], { failAt: 1 }))).rejects.toThrow("rejected");
    const err = await placeInParts(steps([{ kind: "part", fills: 40n }, { kind: "whole" }], { failAt: 2 })).catch((e) => e);
    expect(err).toBeInstanceOf(PartFailedError);
    expect(err).toMatchObject({ sent: 1, remaining: 60n });
  });
});
