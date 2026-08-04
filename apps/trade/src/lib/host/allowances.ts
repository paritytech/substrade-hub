/**
 * Host resource allowances. On the Products Devnet, gas is PGAS, provisioned by the host's
 * `SmartContractAllowance`; it must be granted before the first `Revive.call` or the write is rejected.
 * `AutoSigning` lets subsequent writes proceed without a per-transaction approval.
 */
import {
  requestResourceAllocation,
  type AllocatableResource,
  type DerivationIndex,
} from "@parity/product-sdk-host";
import { isSigningRejection } from "@parity/product-sdk-tx";

/** The product account's derivation index (matches the account we connect via getProductAccount). */
const PRODUCT_ACCOUNT_INDEX = 0 as unknown as DerivationIndex;

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
}
