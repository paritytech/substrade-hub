import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@parity/product-sdk-host", () => ({ requestPermission: vi.fn() }));
vi.mock("../../config/chains", () => ({ activeChain: { rpcUrl: "https://rpc.example/eth-rpc" } }));

import { requestPermission } from "@parity/product-sdk-host";

beforeEach(() => {
  vi.resetModules();
  vi.mocked(requestPermission).mockReset();
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

describe("requestRemoteAccess", () => {
  it("asks for the eth-rpc domain once per session", async () => {
    vi.mocked(requestPermission).mockResolvedValue({ ok: true, value: true } as never);
    const { requestRemoteAccess } = await import("./remote");
    await expect(requestRemoteAccess()).resolves.toBe(true);
    await expect(requestRemoteAccess()).resolves.toBe(true);
    expect(requestPermission).toHaveBeenCalledOnce();
    expect(requestPermission).toHaveBeenCalledWith({ tag: "Remote", value: { domains: ["rpc.example"] } });
  });

  it("resolves false when the user denies it or the host call fails", async () => {
    vi.mocked(requestPermission).mockResolvedValue({ ok: true, value: false } as never);
    await expect((await import("./remote")).requestRemoteAccess()).resolves.toBe(false);
    expect(requestPermission).toHaveBeenCalledTimes(1);

    vi.resetModules();
    vi.mocked(requestPermission).mockResolvedValue({ ok: false, error: new Error("host gone") } as never);
    await expect((await import("./remote")).requestRemoteAccess()).resolves.toBe(false);
    expect(requestPermission).toHaveBeenCalledTimes(2);

    vi.resetModules();
    vi.mocked(requestPermission).mockRejectedValue(new Error("boom"));
    await expect((await import("./remote")).requestRemoteAccess()).resolves.toBe(false);
    expect(requestPermission).toHaveBeenCalledTimes(3);
  });
});
