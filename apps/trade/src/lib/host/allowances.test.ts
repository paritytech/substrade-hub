import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  allocateContractResources,
  provisionContractAllowance,
  awaitContractAllowance,
  getAllowanceStatus,
  resetContractAllowanceStatus,
  CONTRACT_ALLOWANCE_RESOURCES,
} from "./allowances";
import type { AllocatableResource, AllocationOutcome } from "@parity/product-sdk-host";

describe("CONTRACT_ALLOWANCE_RESOURCES", () => {
  it("requests SmartContractAllowance + AutoSigning", () => {
    const tags = CONTRACT_ALLOWANCE_RESOURCES.map((r) => r.tag);
    expect(tags).toEqual(["SmartContractAllowance", "AutoSigning"]);
  });

  it("encodes the derivation index as the tagged-union { tag: 'Index', value: 0 }, not a bare 0", () => {
    // Regression: a bare `0` makes the TruAPI encoder throw `inner[tag] is not a function`.
    const alloc = CONTRACT_ALLOWANCE_RESOURCES.find((r) => r.tag === "SmartContractAllowance")!;
    expect(alloc.value).toEqual({ tag: "Index", value: 0 });
  });
});

describe("allocateContractResources", () => {
  it("passes the resources to the requester and resolves when all are Allocated", async () => {
    const request = vi.fn(async (): Promise<AllocationOutcome[]> => ["Allocated", "Allocated"]);
    await expect(allocateContractResources(request)).resolves.toBeUndefined();
    expect(request).toHaveBeenCalledWith(CONTRACT_ALLOWANCE_RESOURCES);
  });

  it("throws (naming the resource) when a grant is Rejected", async () => {
    const request = vi.fn(async (): Promise<AllocationOutcome[]> => ["Rejected", "Allocated"]);
    await expect(allocateContractResources(request)).rejects.toThrow(/SmartContractAllowance: Rejected/i);
  });

  it("throws when a grant is NotAvailable", async () => {
    const request = vi.fn(async (): Promise<AllocationOutcome[]> => ["Allocated", "NotAvailable"]);
    await expect(allocateContractResources(request)).rejects.toThrow(/AutoSigning: NotAvailable/i);
  });

  it("throws when outcomes are missing entirely (shape mismatch)", async () => {
    const request = vi.fn(async (): Promise<AllocationOutcome[]> => []);
    await expect(allocateContractResources(request)).rejects.toThrow(/did not grant/i);
  });

  it("propagates a throwing requester (host error on the err channel)", async () => {
    const request = vi.fn(async (): Promise<AllocationOutcome[]> => {
      throw new Error("host unavailable");
    });
    await expect(allocateContractResources(request)).rejects.toThrow("host unavailable");
  });
});

describe("allowance gate (provision + await)", () => {
  beforeEach(() => resetContractAllowanceStatus());

  it("starts idle and reports granted after a successful provision", async () => {
    expect(getAllowanceStatus().status).toBe("idle");
    await provisionContractAllowance(async () => ["Allocated", "Allocated"]);
    expect(getAllowanceStatus().status).toBe("granted");
    await expect(awaitContractAllowance()).resolves.toBeUndefined();
  });

  it("a waiter registered while pending resolves once the grant completes", async () => {
    let release!: (o: AllocationOutcome[]) => void;
    const request = (): Promise<AllocationOutcome[]> =>
      new Promise((r) => {
        release = r;
      });
    const provision = provisionContractAllowance(request as (r: AllocatableResource[]) => Promise<AllocationOutcome[]>);
    const waiter = awaitContractAllowance();
    expect(getAllowanceStatus().status).toBe("pending");
    release(["Allocated", "Allocated"]);
    await provision;
    await expect(waiter).resolves.toBeUndefined();
  });

  it("a waiter registered before provisioning rejects when the grant is denied", async () => {
    const waiter = awaitContractAllowance(); // registered while idle
    await expect(
      provisionContractAllowance(async () => ["Rejected", "Allocated"]),
    ).rejects.toThrow(/did not grant/i);
    await expect(waiter).rejects.toThrow(/did not grant/i);
    expect(getAllowanceStatus().status).toBe("error");
  });

  it("reset returns the gate to idle for the next session", async () => {
    await provisionContractAllowance(async () => ["Allocated", "Allocated"]);
    resetContractAllowanceStatus();
    expect(getAllowanceStatus().status).toBe("idle");
  });

  it("reset while pending rejects the waiter and ignores the stale completion", async () => {
    let release!: (o: AllocationOutcome[]) => void;
    const request = (): Promise<AllocationOutcome[]> =>
      new Promise((r) => {
        release = r;
      });
    const provision = provisionContractAllowance(
      request as (r: AllocatableResource[]) => Promise<AllocationOutcome[]>,
    );
    const waiter = awaitContractAllowance();
    expect(getAllowanceStatus().status).toBe("pending");

    resetContractAllowanceStatus();
    await expect(waiter).rejects.toThrow(/session ended/i);
    expect(getAllowanceStatus().status).toBe("idle");

    // The old provisioning now completes — it is stale and must not flip the gate back to granted.
    release(["Allocated", "Allocated"]);
    await provision;
    expect(getAllowanceStatus().status).toBe("idle");
  });

  it("an older provisioning completing after a newer one does not overwrite status", async () => {
    let releaseOld!: (o: AllocationOutcome[]) => void;
    const oldReq = (): Promise<AllocationOutcome[]> =>
      new Promise((r) => {
        releaseOld = r;
      });
    const oldProvision = provisionContractAllowance(
      oldReq as (r: AllocatableResource[]) => Promise<AllocationOutcome[]>,
    );

    // A newer session supersedes it and settles first.
    await provisionContractAllowance(async () => ["Allocated", "Allocated"]);
    expect(getAllowanceStatus().status).toBe("granted");

    // The stale one now fails; it must be ignored (rethrown for the SDK log, but no status change).
    releaseOld(["Rejected", "Allocated"]);
    await expect(oldProvision).rejects.toThrow(/did not grant/i);
    expect(getAllowanceStatus().status).toBe("granted");
  });
});
