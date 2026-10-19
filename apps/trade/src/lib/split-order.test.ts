import { describe, expect, it, vi } from "vitest";
import { MAX_PARTS, PartFailedError, placeInParts, TooManyPartsError, type PartOutcome } from "./split-order";

/**
 * Steps whose simulation answers from `outcomes` in turn. Each part places its whole size unless
 * `placed` says otherwise for that part number (the contract handed the rest back).
 */
function steps(
  outcomes: PartOutcome[],
  opts: { amount?: bigint; min?: bigint; confirm?: boolean[]; failAt?: number; placed?: Record<number, bigint> } = {},
) {
  const sent: Array<{ size: bigint; part: number; of: number; outcome: string }> = [];
  const answers = [...(opts.confirm ?? [])];
  const simulate = vi.fn<(remaining: bigint) => Promise<PartOutcome>>(async () => outcomes.shift() ?? { kind: "whole" });
  const confirm = vi.fn<(parts: number, sent: number) => Promise<boolean>>(async () => answers.shift() ?? true);
  const send = vi.fn(async (size: bigint, part: number, of: number, outcome: string) => {
    if (part === opts.failAt) throw new Error("rejected");
    sent.push({ size, part, of, outcome });
    return opts.placed?.[part] ?? size;
  });
  return { sent, simulate, confirm, send, amount: opts.amount ?? 100n, minOrderSize: opts.min ?? 10n };
}

describe("placeInParts", () => {
  it("sends an order that fits in one transaction without asking", async () => {
    const s = steps([{ kind: "whole" }]);
    expect(await placeInParts(s)).toEqual({ status: "done", sent: 1 });
    expect(s.confirm).not.toHaveBeenCalled();
    expect(s.sent).toEqual([{ size: 100n, part: 1, of: 1, outcome: "whole" }]);
  });

  it("asks once, then sends parts sized to each simulation until one takes the rest", async () => {
    const s = steps([{ kind: "part", fills: 40n }, { kind: "part", fills: 40n }, { kind: "whole" }]);
    expect(await placeInParts(s)).toEqual({ status: "done", sent: 3 });
    expect(s.confirm.mock.calls).toEqual([[3, 0]]);
    expect(s.simulate.mock.calls.map((c) => c[0])).toEqual([100n, 60n, 20n]);
    expect(s.sent.map((p) => [p.size, p.part, p.of])).toEqual([[40n, 1, 3], [40n, 2, 3], [20n, 3, 3]]);
  });

  it("tries again what a part handed back, instead of counting it as placed", async () => {
    // Part 1 was simulated at 40 but placed 25: the next simulation is for 75.
    const s = steps([{ kind: "part", fills: 40n }, { kind: "part", fills: 40n }, { kind: "whole" }], { placed: { 1: 25n } });
    expect(await placeInParts(s)).toEqual({ status: "done", sent: 3 });
    expect(s.simulate.mock.calls.map((c) => c[0])).toEqual([100n, 75n, 35n]);
  });

  it("reports a market order that ran out of book as not filled", async () => {
    // One transaction looked enough; the contract handed 30 back and nothing is left within the price.
    const s = steps([{ kind: "whole" }, { kind: "none" }], { placed: { 1: 70n } });
    expect(await placeInParts(s)).toEqual({ status: "dry", sent: 1, remaining: 30n });
    expect(s.confirm).not.toHaveBeenCalled();
  });

  it("asks before a part beyond what the user agreed to", async () => {
    // One transaction looked enough, but 60 came back and needs two more.
    const s = steps([{ kind: "whole" }, { kind: "part", fills: 30n }, { kind: "whole" }], { placed: { 1: 40n } });
    expect(await placeInParts(s)).toEqual({ status: "done", sent: 3 });
    expect(s.confirm.mock.calls).toEqual([[3, 1]]);
  });

  it("stops where the user declines, before or after parts went out", async () => {
    const before = steps([{ kind: "part", fills: 40n }], { confirm: [false] });
    expect(await placeInParts(before)).toEqual({ status: "cancelled", sent: 0, remaining: 100n });
    expect(before.send).not.toHaveBeenCalled();

    const after = steps([{ kind: "whole" }, { kind: "part", fills: 30n }], { placed: { 1: 40n }, confirm: [false] });
    expect(await placeInParts(after)).toEqual({ status: "cancelled", sent: 1, remaining: 60n });
  });

  it("raises the estimate when the book fills less than expected, asking only past the agreed count", async () => {
    const s = steps([{ kind: "part", fills: 50n }, { kind: "part", fills: 20n }, { kind: "part", fills: 20n }, { kind: "whole" }]);
    await placeInParts(s);
    expect(s.sent.map((p) => p.of)).toEqual([2, 4, 4, 4]);
    expect(s.confirm.mock.calls).toEqual([[2, 0], [4, 2]]);
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
    const s = steps([{ kind: "part", fills: 40n }, { kind: "clears" }], { placed: { 2: 3n } });
    expect(await placeInParts(s)).toEqual({ status: "cleared", sent: 2, remaining: 57n });
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
