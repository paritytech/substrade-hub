import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
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
  it("passes the resources to the requester and reports nothing when all are Allocated", async () => {
    const request = vi.fn(async (): Promise<AllocationOutcome[]> => ["Allocated", "Allocated"]);
    await expect(allocateContractResources(request)).resolves.toEqual([]);
    expect(request).toHaveBeenCalledWith(CONTRACT_ALLOWANCE_RESOURCES);
  });

  it("reports a Rejected or NotAvailable resource by name, without throwing", async () => {
    const request = vi.fn(async (): Promise<AllocationOutcome[]> => ["Rejected", "NotAvailable"]);
    await expect(allocateContractResources(request)).resolves.toEqual([
      "SmartContractAllowance: Rejected",
      "AutoSigning: NotAvailable",
    ]);
  });

  it("reports missing outcomes (shape mismatch)", async () => {
    const request = vi.fn(async (): Promise<AllocationOutcome[]> => []);
    await expect(allocateContractResources(request)).resolves.toEqual([
      "SmartContractAllowance: missing",
      "AutoSigning: missing",
    ]);
  });

  it("reports a throwing requester (host error) instead of propagating it", async () => {
    const request = vi.fn(async (): Promise<AllocationOutcome[]> => {
      throw new Error("host unavailable");
    });
    await expect(allocateContractResources(request)).resolves.toEqual(["request failed: host unavailable"]);
  });
});

describe("allowance gate (provision + await)", () => {
  beforeEach(() => resetContractAllowanceStatus());
  afterEach(() => vi.restoreAllMocks());

  it("starts idle and opens once the request is answered", async () => {
    expect(getAllowanceStatus().status).toBe("idle");
    await provisionContractAllowance(async () => ["Allocated", "Allocated"]);
    expect(getAllowanceStatus()).toEqual({ status: "answered", notAllocated: [] });
    await expect(awaitContractAllowance()).resolves.toBeUndefined();
  });

  it("a waiter registered while pending resolves once the request is answered", async () => {
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

  it("a denied or unavailable allowance still opens the gate, and is recorded", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const waiter = awaitContractAllowance(); // registered while idle
    await expect(provisionContractAllowance(async () => ["NotAvailable", "Rejected"])).resolves.toBeUndefined();
    await expect(waiter).resolves.toBeUndefined();
    expect(getAllowanceStatus()).toEqual({
      status: "answered",
      notAllocated: ["SmartContractAllowance: NotAvailable", "AutoSigning: Rejected"],
    });
  });

  it("reset returns the gate to idle for the next session", async () => {
    await provisionContractAllowance(async () => ["Allocated", "Allocated"]);
    resetContractAllowanceStatus();
    expect(getAllowanceStatus().status).toBe("idle");
  });

  it("reset while pending rejects the waiter and ignores the stale answer", async () => {
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

    // The old request now completes; it is stale and must not reopen the gate.
    release(["Allocated", "Allocated"]);
    await provision;
    expect(getAllowanceStatus().status).toBe("idle");
  });

  it("an older request answered after a newer one does not overwrite the status", async () => {
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
    expect(getAllowanceStatus()).toEqual({ status: "answered", notAllocated: [] });

    // The stale one now answers with a denial; it must be ignored.
    releaseOld(["Rejected", "Allocated"]);
    await oldProvision;
    expect(getAllowanceStatus()).toEqual({ status: "answered", notAllocated: [] });
  });
});
