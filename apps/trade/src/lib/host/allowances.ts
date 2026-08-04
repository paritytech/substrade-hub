/**
 * Host resource allowances. On the Products Devnet, gas is PGAS, provisioned by the host's
 * `SmartContractAllowance`; it must be granted before the first `Revive.call` or the write is rejected.
 * `AutoSigning` lets subsequent writes proceed without a per-transaction approval.
 *
 * Provisioning is wired into `SignerManager`'s `onConnect` (see signer.ts), which the SDK fires once per
 * session — on the initial connect and again after every auto-reconnect / fresh host session — so grants
 * are re-provisioned whenever a session refreshes or an allocation expires.
 *
 * Timing: the SDK emits "connected" to subscribers BEFORE it runs `onConnect`, and it only logs a thrown
 * `onConnect`. So the lifecycle subscription can populate the wallet before allocation finishes. To stop
 * an apparently-connected-but-unauthorized wallet, `onConnect` drives a shared allowance gate here that
 * `writeContract` (every host write) and the connect modal both await; a rejection surfaces instead of
 * silently failing the first write.
 */
import type {
  AllocatableResource,
  AllocationOutcome,
  DerivationIndex,
} from "@parity/product-sdk-host";

/**
 * The product account's derivation index (matches `getProductAccount(dappName, 0)`). `DerivationIndex`
 * is a tagged union in the host codec: `{ tag: "Left", value: number }` for a plain index. A bare `0`
 * makes the TruAPI encoder throw (`inner[tag] is not a function`), so it must be built explicitly.
 */
const PRODUCT_ACCOUNT_INDEX: DerivationIndex = { tag: "Left", value: 0 };

/** The resources the contract flow needs, granted together once per host session. */
export const CONTRACT_ALLOWANCE_RESOURCES: AllocatableResource[] = [
  { tag: "SmartContractAllowance", value: PRODUCT_ACCOUNT_INDEX },
  { tag: "AutoSigning", value: undefined },
];

/**
 * Validate the per-resource outcomes ("Allocated" | "Rejected" | "NotAvailable", in request order): a
 * non-"Allocated" outcome means the grant did not happen, so throw naming the offending resource(s).
 */
export async function allocateContractResources(
  request: (resources: AllocatableResource[]) => Promise<AllocationOutcome[]>,
): Promise<void> {
  const outcomes = await request(CONTRACT_ALLOWANCE_RESOURCES);
  const denied = CONTRACT_ALLOWANCE_RESOURCES.map((r, i) => ({ tag: r.tag, outcome: outcomes[i] })).filter(
    (x) => x.outcome !== "Allocated",
  );
  if (denied.length > 0) {
    const detail = denied.map((d) => `${d.tag}: ${d.outcome ?? "missing"}`).join(", ");
    throw new Error(`The host did not grant the contract allowance (${detail}).`);
  }
}

// ── Shared allowance gate ────────────────────────────────────────────────────
export type AllowanceStatus = "idle" | "pending" | "granted" | "error";

interface Waiter {
  resolve: () => void;
  reject: (e: Error) => void;
}

// `generation` tags each provisioning attempt. It is bumped both when a new attempt begins AND on reset,
// so a completion whose generation is stale (a newer attempt started, or the session was reset while it
// was in flight) is ignored and can never overwrite the current session's status. Reset also rejects any
// outstanding waiters so a gated write can't hang on a dead session.
let generation = 0;
let status: AllowanceStatus = "idle";
let lastError: Error | null = null;
const waiters = new Set<Waiter>();

function drainWaiters(): void {
  if (status === "granted") {
    for (const w of [...waiters]) {
      waiters.delete(w);
      w.resolve();
    }
  } else if (status === "error") {
    const err = lastError ?? new Error("allowance not granted");
    for (const w of [...waiters]) {
      waiters.delete(w);
      w.reject(err);
    }
  }
}

export function getAllowanceStatus(): { status: AllowanceStatus; error: Error | null } {
  return { status, error: lastError };
}

/**
 * Invalidate the current session — call on explicit disconnect and whenever host state leaves
 * "connected". Bumps the generation so an in-flight provisioning completion is ignored, drops to "idle",
 * and rejects any waiters so a pending host write fails fast rather than hanging on a dead session.
 */
export function resetContractAllowanceStatus(): void {
  generation += 1;
  status = "idle";
  lastError = null;
  const err = new Error("Host session ended before the contract allowance was granted.");
  for (const w of [...waiters]) {
    waiters.delete(w);
    w.reject(err);
  }
}

/**
 * Run the allocation for a session and track its status, tagged with a generation so a stale completion
 * (superseded by a newer attempt or a reset) can't clobber the current session. Called from `onConnect`;
 * rethrows so the SDK logs it. `awaitContractAllowance` carries the result to the gated consumers.
 */
export async function provisionContractAllowance(
  request: (resources: AllocatableResource[]) => Promise<AllocationOutcome[]>,
): Promise<void> {
  generation += 1;
  const gen = generation;
  status = "pending";
  lastError = null;
  try {
    await allocateContractResources(request);
    if (gen !== generation) return; // superseded — leave the newer session's state untouched
    status = "granted";
    lastError = null;
    drainWaiters();
  } catch (e) {
    const err = e instanceof Error ? e : new Error(String(e));
    if (gen !== generation) throw err; // superseded — don't touch state, just surface for the SDK log
    status = "error";
    lastError = err;
    drainWaiters();
    throw err;
  }
}

/**
 * Resolve once the current session's allowance is granted; reject if it failed or the session was reset.
 * Waits through the "idle"/"pending" window (the microtask gap after "connected" but before `onConnect`).
 * Every host `writeContract` and the connect modal await this.
 */
export function awaitContractAllowance(): Promise<void> {
  if (status === "granted") return Promise.resolve();
  if (status === "error") return Promise.reject(lastError ?? new Error("allowance not granted"));
  return new Promise<void>((resolve, reject) => {
    waiters.add({ resolve, reject });
  });
}
