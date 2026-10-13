/**
 * Host resource allowances, requested once per host session and best-effort.
 *
 * `SmartContractAllowance` is the product account's PGAS allowance, which pays the gas of its
 * `Revive.call` transactions. `AutoSigning` lets later writes proceed without a per-transaction
 * approval. Hosts differ in how they provide them: the Android host tops up the PGAS allowance by itself
 * whenever the product signs a transaction made only of Revive calls, while other hosts answer
 * `NotAvailable`. So the request is made up front, where it helps, and its outcome never blocks the
 * user: an account whose allowance was not granted still connects, and any write that then cannot pay
 * fails with the chain's own error, which the order flow shows.
 *
 * Provisioning is wired into `SignerManager`'s `onConnect` (see signer.ts), which the SDK fires once per
 * session (the initial connect and every auto-reconnect), so the request repeats when a session
 * refreshes.
 *
 * Timing: the SDK emits "connected" before it runs `onConnect`. Writes and the connect modal wait on the
 * gate here until the request has been answered, so the host's allowance prompt and a signing prompt
 * never compete. The gate opens on any answer, and closes again only when the session ends.
 */
import type {
  AllocatableResource,
  AllocationOutcome,
  DerivationIndex,
} from "@parity/product-sdk-host";

/**
 * The product account's derivation index (matches `getProductAccount(dappName, 0)`). `DerivationIndex`
 * is a tagged union in the host codec: `{ tag: "Index", value: number }` for a plain index. A bare `0`
 * makes the TruAPI encoder throw (`inner[tag] is not a function`), so it must be built explicitly.
 */
const PRODUCT_ACCOUNT_INDEX: DerivationIndex = { tag: "Index", value: 0 };

/** The resources the contract flow asks for, together, once per host session. */
export const CONTRACT_ALLOWANCE_RESOURCES: AllocatableResource[] = [
  { tag: "SmartContractAllowance", value: PRODUCT_ACCOUNT_INDEX },
  { tag: "AutoSigning", value: undefined },
];

/**
 * Request the resources and report the ones the host did not allocate, as `"Tag: Outcome"` entries (in
 * request order). An empty list means everything was allocated. A failing request is reported as such.
 */
export async function allocateContractResources(
  request: (resources: AllocatableResource[]) => Promise<AllocationOutcome[]>,
): Promise<string[]> {
  let outcomes: AllocationOutcome[];
  try {
    outcomes = await request(CONTRACT_ALLOWANCE_RESOURCES);
  } catch (e) {
    return [`request failed: ${e instanceof Error ? e.message : String(e)}`];
  }
  return CONTRACT_ALLOWANCE_RESOURCES.map((r, i) => ({ tag: r.tag, outcome: outcomes[i] }))
    .filter((x) => x.outcome !== "Allocated")
    .map((x) => `${x.tag}: ${x.outcome ?? "missing"}`);
}

// ── Shared allowance gate ────────────────────────────────────────────────────
export type AllowanceStatus = "idle" | "pending" | "answered";

interface Waiter {
  resolve: () => void;
  reject: (e: Error) => void;
}

// `generation` tags each provisioning attempt. It is bumped both when a new attempt begins and on reset,
// so a completion whose generation is stale (a newer attempt started, or the session was reset while it
// was in flight) is ignored and can never overwrite the current session's status. Reset also rejects any
// outstanding waiters so a gated write can't hang on a dead session.
let generation = 0;
let status: AllowanceStatus = "idle";
let notAllocated: string[] = [];
const waiters = new Set<Waiter>();

/** The gate's state, plus the resources the host did not allocate in the current session. */
export function getAllowanceStatus(): { status: AllowanceStatus; notAllocated: string[] } {
  return { status, notAllocated };
}

/**
 * Invalidate the current session: call on explicit disconnect and whenever host state leaves
 * "connected". Bumps the generation so an in-flight request's answer is ignored, drops to "idle", and
 * rejects any waiters so a pending host write fails fast instead of hanging on a dead session.
 */
export function resetContractAllowanceStatus(): void {
  generation += 1;
  status = "idle";
  notAllocated = [];
  const err = new Error("Host session ended before the contract allowance request was answered.");
  for (const w of [...waiters]) {
    waiters.delete(w);
    w.reject(err);
  }
}

/**
 * Request the session's resources and open the gate once the host answers, whatever the answer. Called
 * from `onConnect`. Never throws: an unallocated resource is logged and recorded.
 */
export async function provisionContractAllowance(
  request: (resources: AllocatableResource[]) => Promise<AllocationOutcome[]>,
): Promise<void> {
  generation += 1;
  const gen = generation;
  status = "pending";
  notAllocated = [];
  const missing = await allocateContractResources(request);
  if (gen !== generation) return; // superseded: leave the newer session's state untouched
  if (missing.length) console.warn(`[host] resources not allocated (continuing): ${missing.join(", ")}`);
  status = "answered";
  notAllocated = missing;
  for (const w of [...waiters]) {
    waiters.delete(w);
    w.resolve();
  }
}

/**
 * Resolve once the current session's allowance request has been answered; reject if the session ended
 * first. Waits through the "idle"/"pending" window (the gap after "connected" but before `onConnect`).
 * Every host `writeContract` and the connect modal await this.
 */
export function awaitContractAllowance(): Promise<void> {
  if (status === "answered") return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    waiters.add({ resolve, reject });
  });
}
