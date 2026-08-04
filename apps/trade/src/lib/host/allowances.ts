/**
 * Host resource allowances. On the Products Devnet, gas is PGAS, provisioned by the host's
 * `SmartContractAllowance`; it must be granted before the first `Revive.call` or the write is rejected.
 * `AutoSigning` lets subsequent writes proceed without a per-transaction approval.
 */
import {
  requestResourceAllocation,
  type AllocatableResource,
  type AllocationOutcome,
  type DerivationIndex,
} from "@parity/product-sdk-host";
import { isSigningRejection } from "@parity/product-sdk-tx";

/**
 * The product account's derivation index (matches `getProductAccount(dappName, 0)`). `DerivationIndex`
 * is a tagged union in the host codec: `{ tag: "Left", value: number }` for a plain index. A bare `0`
 * makes the TruAPI encoder throw (`inner[tag] is not a function`), so it must be built explicitly.
 */
const PRODUCT_ACCOUNT_INDEX: DerivationIndex = { tag: "Left", value: 0 };

export async function ensureContractAllowance(): Promise<void> {
  const resources: AllocatableResource[] = [
    { tag: "SmartContractAllowance", value: PRODUCT_ACCOUNT_INDEX },
    { tag: "AutoSigning", value: undefined },
  ];
  const res = await requestResourceAllocation(resources);
  if (!res.ok) {
    if (isSigningRejection(res.error)) {
      throw new Error("Allowance request was declined in the wallet.");
    }
    throw new Error(res.error.message || "Failed to request the contract allowance");
  }

  // `ok` only means the request reached the host. Each resource carries its own outcome
  // ("Allocated" | "Rejected" | "NotAvailable"), in the same order as `resources`. A non-"Allocated"
  // outcome means the grant did not happen, so accepting `ok` blindly would mark the wallet connected
  // and let the first Revive.call fail for no visible reason. Surface it here instead.
  const outcomes: AllocationOutcome[] = res.value;
  const denied = resources
    .map((r, i) => ({ tag: r.tag, outcome: outcomes[i] }))
    .filter((x) => x.outcome !== "Allocated");
  if (denied.length > 0) {
    const detail = denied.map((d) => `${d.tag}: ${d.outcome ?? "missing"}`).join(", ");
    throw new Error(`The host did not grant the contract allowance (${detail}).`);
  }
}
