import { vi, describe, it, expect, beforeEach } from "vitest";

vi.mock("@parity/product-sdk-host", () => ({ requestResourceAllocation: vi.fn() }));
vi.mock("@parity/product-sdk-tx", () => ({ isSigningRejection: vi.fn(() => false) }));

import { ensureContractAllowance } from "./allowances";
import { requestResourceAllocation } from "@parity/product-sdk-host";
import { isSigningRejection } from "@parity/product-sdk-tx";

beforeEach(() => vi.clearAllMocks());

describe("ensureContractAllowance", () => {
  it("requests SmartContractAllowance + AutoSigning and resolves when all are Allocated", async () => {
    vi.mocked(requestResourceAllocation).mockResolvedValue({
      ok: true,
      value: ["Allocated", "Allocated"],
    } as never);
    await expect(ensureContractAllowance()).resolves.toBeUndefined();
    const tags = vi.mocked(requestResourceAllocation).mock.calls[0]![0].map((r) => r.tag);
    expect(tags).toContain("SmartContractAllowance");
    expect(tags).toContain("AutoSigning");
  });

  it("encodes the derivation index as the tagged-union { tag: 'Left', value: 0 }, not a bare 0", async () => {
    // Regression: a bare `0` makes the TruAPI encoder throw `inner[tag] is not a function`.
    vi.mocked(requestResourceAllocation).mockResolvedValue({
      ok: true,
      value: ["Allocated", "Allocated"],
    } as never);
    await ensureContractAllowance();
    const resources = vi.mocked(requestResourceAllocation).mock.calls[0]![0];
    const alloc = resources.find((r) => r.tag === "SmartContractAllowance")!;
    expect(alloc.value).toEqual({ tag: "Left", value: 0 });
  });

  it("throws when a resource comes back Rejected (does not mark the wallet connected)", async () => {
    vi.mocked(requestResourceAllocation).mockResolvedValue({
      ok: true,
      value: ["Rejected", "Allocated"],
    } as never);
    await expect(ensureContractAllowance()).rejects.toThrow(/did not grant/i);
  });

  it("throws when a resource comes back NotAvailable", async () => {
    vi.mocked(requestResourceAllocation).mockResolvedValue({
      ok: true,
      value: ["Allocated", "NotAvailable"],
    } as never);
    await expect(ensureContractAllowance()).rejects.toThrow(/AutoSigning: NotAvailable/i);
  });

  it("throws when outcomes are missing entirely (shape mismatch)", async () => {
    vi.mocked(requestResourceAllocation).mockResolvedValue({ ok: true, value: [] } as never);
    await expect(ensureContractAllowance()).rejects.toThrow(/did not grant/i);
  });

  it("throws a 'declined' message when the user rejects", async () => {
    vi.mocked(requestResourceAllocation).mockResolvedValue({
      ok: false,
      error: { message: "x" },
    } as never);
    vi.mocked(isSigningRejection).mockReturnValue(true);
    await expect(ensureContractAllowance()).rejects.toThrow(/declined/i);
  });

  it("throws the host error message on other failures", async () => {
    vi.mocked(requestResourceAllocation).mockResolvedValue({
      ok: false,
      error: { message: "host down" },
    } as never);
    vi.mocked(isSigningRejection).mockReturnValue(false);
    await expect(ensureContractAllowance()).rejects.toThrow("host down");
  });
});
