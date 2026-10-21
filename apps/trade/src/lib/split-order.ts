/**
 * Placing an order that one transaction cannot fill, in several transactions. One transaction does a
 * bounded amount of matching (the contracts' match budget), so an order crossing more resting orders
 * goes in parts: each one sized to what a simulation says it fills, so its escrow is what fills, and
 * each carrying the user's price, so orders arriving in between change only how much a part fills.
 * What a part placed is read from its transaction, so anything the contract handed back is tried again.
 */

/** Most transactions one order is placed in. */
export const MAX_PARTS = 10;

/** What one transaction for the rest of an order would do, from a simulation. */
export type PartOutcome =
  /** It takes all of it: fills it, rests it (a limit order) or returns what the book cannot fill. */
  | { kind: "whole" }
  /** It takes `fills` and stops at the match budget; the rest needs another transaction. */
  | { kind: "part"; fills: bigint }
  /**
   * It only clears expired, small or the trader's own orders at the front of the book, and the rest
   * comes back.
   */
  | { kind: "clears" }
  /** It fills nothing: no orders within the price. */
  | { kind: "none" };

/** How an order placed in parts ended. `remaining` is what was not placed, and stayed with the user. */
export type PartsResult =
  | { status: "done"; sent: number }
  /** The book within the price ran out. */
  | { status: "dry"; sent: number; remaining: bigint }
  /** What is left is below the minimum order size, so it cannot be placed. */
  | { status: "dust"; sent: number; remaining: bigint }
  /** `MAX_PARTS` transactions went out. */
  | { status: "capped"; sent: number; remaining: bigint }
  /** The last part only cleared the front of the book. */
  | { status: "cleared"; sent: number; remaining: bigint }
  /** The last part was included but placed nothing the app could read, so nothing more is sent. */
  | { status: "unconfirmed"; sent: number; remaining: bigint }
  /** The user declined more parts, after `sent` went out (none, when declined before the first). */
  | { status: "cancelled"; sent: number; remaining: bigint };

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
  /** Ask whether to go ahead with about `parts` transactions in all, `sent` of them already sent. */
  confirm(parts: number, sent: number): Promise<boolean>;
  /**
   * Send part `part` of about `of`, for `size`, as `outcome` simulated it. Resolves once included, with
   * the base amount the transaction placed: what it filled plus what rests.
   */
  send(size: bigint, part: number, of: number, outcome: PartOutcome["kind"]): Promise<bigint>;
}

/** Transactions `remaining` needs when one takes `outcome`. */
function partsFor(remaining: bigint, outcome: PartOutcome): number {
  if (outcome.kind !== "part") return 1;
  return Number((remaining + outcome.fills - 1n) / outcome.fills);
}

/**
 * Place the order in as many transactions as it needs. An order that fits in one is sent without
 * asking; the user is asked before the first part when it needs more, and again before a part beyond
 * the number they agreed to. A part that only clears the front of the book ends the order: the rest
 * comes back, to be placed again. Rejects with `TooManyPartsError` before anything is sent, or
 * `PartFailedError` once a part has been.
 */
export async function placeInParts(steps: PlaceInPartsSteps): Promise<PartsResult> {
  let remaining = steps.amount;
  let sent = 0;
  let agreed = 1;
  let outcome = await steps.simulate(remaining);
  if (outcome.kind === "none") return { status: "dry", sent, remaining };
  let of = partsFor(remaining, outcome);
  if (of > MAX_PARTS && outcome.kind === "part") throw new TooManyPartsError(outcome.fills);

  for (;;) {
    if ((sent === 0 && of > 1) || sent + 1 > agreed) {
      if (!(await steps.confirm(of, sent))) return { status: "cancelled", sent, remaining };
      agreed = of;
    }
    const size = outcome.kind === "part" ? outcome.fills : remaining;
    let placed: bigint;
    try {
      placed = await steps.send(size, sent + 1, of, outcome.kind);
    } catch (err) {
      if (sent === 0) throw err;
      throw new PartFailedError(sent, remaining, err);
    }
    sent++;
    // A part that placed nothing, or whose events could not be read, is never sent again: resending
    // what may have been placed would place it twice. A clearing part places little by design.
    if (placed === 0n && outcome.kind !== "clears") return { status: "unconfirmed", sent, remaining };
    remaining -= placed < remaining ? placed : remaining;

    if (remaining === 0n) return { status: "done", sent };
    if (outcome.kind === "clears") return { status: "cleared", sent, remaining };
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
