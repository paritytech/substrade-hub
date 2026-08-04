import { vi, describe, it, expect, beforeEach } from "vitest";

vi.mock("@parity/product-sdk-host", () => ({ requestResourceAllocation: vi.fn() }));
vi.mock("@parity/product-sdk-tx", () => ({ isSigningRejection: vi.fn(() => false) }));

import { ensureContractAllowance } from "./allowances";
import { requestResourceAllocation } from "@parity/product-sdk-host";
import { isSigningRejection } from "@parity/product-sdk-tx";

beforeEach(() => vi.clearAllMocks());

describe("ensureContractAllowance", () => {
  it("requests SmartContractAllowance + AutoSigning and resolves on success", async () => {
    vi.mocked(requestResourceAllocation).mockResolvedValue({ ok: true, value: [] } as never);
    await expect(ensureContractAllowance()).resolves.toBeUndefined();
    const tags = vi.mocked(requestResourceAllocation).mock.calls[0]![0].map((r) => r.tag);
    expect(tags).toContain("SmartContractAllowance");
    expect(tags).toContain("AutoSigning");
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
