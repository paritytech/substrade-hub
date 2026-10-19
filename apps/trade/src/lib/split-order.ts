/**
 * Placing an order that one transaction cannot fill, in several transactions. One transaction does a
 * bounded amount of matching (the contracts' match budget), so an order crossing more resting orders
 * goes in parts: each one sized to what a simulation says it fills, so its escrow is what fills, and
 * each carrying the user's price, so orders arriving in between change only how much a part fills.
 */

/** Most transactions one order is placed in. */
export const MAX_PARTS = 10;

/** What one transaction for the rest of an order would do, from a simulation. */
export type PartOutcome =
  /** It takes all of it: fills it, rests it (a limit order) or returns what the book cannot fill. */
  | { kind: "whole" }
  /** It takes `fills` and stops at the match budget; the rest needs another transaction. */
  | { kind: "part"; fills: bigint }
  /** It only clears expired or small orders at the front of the book, and the rest comes back. */
  | { kind: "clears" }
  /** It fills nothing: no orders within the price. */
  | { kind: "none" };

/** How an order placed in parts ended. */
export type PartsResult =
  | { status: "done"; sent: number; final: PartOutcome["kind"] }
  /** The book within the price ran out; `remaining` stayed with the user. */
  | { status: "dry"; sent: number; remaining: bigint }
  /** What is left is below the minimum order size, so it cannot be placed. */
  | { status: "dust"; sent: number; remaining: bigint }
  /** `MAX_PARTS` transactions went out and `remaining` was not placed. */
  | { status: "capped"; sent: number; remaining: bigint }
  /** The user declined the parts before any was sent. */
  | { status: "cancelled" };

/** A part failed, or its signature was rejected, after `sent` parts went out; `remaining` was not placed. */
export class PartFailedError extends Error {
  readonly sent: number;
  readonly remaining: bigint;

  constructor(sent: number, remaining: bigint, cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.name = "PartFailedError";
    this.sent = sent;
    this.remaining = remaining;
  }
}

/** Raised when the order needs more than `MAX_PARTS` transactions; `perPart` is what one fills. */
export class TooManyPartsError extends Error {
  readonly perPart: bigint;

  constructor(perPart: bigint) {
    super(`order needs more than ${MAX_PARTS} transactions`);
    this.name = "TooManyPartsError";
    this.perPart = perPart;
  }
}

export interface PlaceInPartsSteps {
  amount: bigint;
  minOrderSize: bigint;
  /** Simulate one transaction for `remaining` of the order. */
  simulate(remaining: bigint): Promise<PartOutcome>;
  /** Ask whether to go ahead with about `parts` transactions; only asked for more than one. */
  confirm(parts: number): Promise<boolean>;
  /** Send part `part` of about `of`, for `size`, as `outcome` simulated it. Resolves once included. */
  send(size: bigint, part: number, of: number, outcome: PartOutcome["kind"]): Promise<void>;
}

/** Transactions `remaining` needs when one takes `outcome`. */
function partsFor(remaining: bigint, outcome: PartOutcome): number {
  if (outcome.kind !== "part") return 1;
  return Number((remaining + outcome.fills - 1n) / outcome.fills);
}

/**
 * Place the order in as many transactions as it needs. An order that fits in one is sent without
 * asking. A part that only clears the front of the book ends the order: the rest comes back, to be
 * placed again. Rejects with `TooManyPartsError` before anything is sent, or `PartFailedError` once a
 * part has been; a simulation that finds nothing to fill at first resolves as `dry` with nothing sent.
 */
export async function placeInParts(steps: PlaceInPartsSteps): Promise<PartsResult> {
  let remaining = steps.amount;
  let outcome = await steps.simulate(remaining);
  if (outcome.kind === "none") return { status: "dry", sent: 0, remaining };

  let of = partsFor(remaining, outcome);
  if (of > MAX_PARTS && outcome.kind === "part") throw new TooManyPartsError(outcome.fills);
  if (of > 1 && !(await steps.confirm(of))) return { status: "cancelled" };

  let sent = 0;
  for (;;) {
    const size = outcome.kind === "part" ? outcome.fills : remaining;
    try {
      await steps.send(size, sent + 1, of, outcome.kind);
    } catch (err) {
      if (sent === 0) throw err;
      throw new PartFailedError(sent, remaining, err);
    }
    sent++;
    if (outcome.kind !== "part") return { status: "done", sent, final: outcome.kind };

    remaining -= size;
    if (remaining < steps.minOrderSize) return { status: "dust", sent, remaining };
    if (sent >= MAX_PARTS) return { status: "capped", sent, remaining };

    try {
      outcome = await steps.simulate(remaining);
    } catch (err) {
      throw new PartFailedError(sent, remaining, err);
    }
    if (outcome.kind === "none") return { status: "dry", sent, remaining };
    of = Math.max(of, sent + partsFor(remaining, outcome));
  }
}
