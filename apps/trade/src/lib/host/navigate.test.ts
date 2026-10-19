import { afterEach, describe, expect, it, vi } from "vitest";

const { navigateTo, inHost } = vi.hoisted(() => ({ navigateTo: vi.fn(), inHost: { value: true } }));
vi.mock("@parity/product-sdk-host", () => ({ navigateTo }));
vi.mock("./detect", () => ({ isInHost: () => inHost.value }));

import { openExternal } from "./navigate";

const URL = "https://faucet.polkadot.io/?parachain=1500";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  navigateTo.mockReset();
  inHost.value = true;
});

describe("openExternal", () => {
  it("leaves the link to the browser outside a host", () => {
    inHost.value = false;
    expect(openExternal(URL)).toBe(false);
    expect(navigateTo).not.toHaveBeenCalled();
  });

  it("asks the host to navigate inside a host", async () => {
    navigateTo.mockResolvedValue({ ok: true });
    expect(openExternal(URL)).toBe(true);
    await vi.waitFor(() => expect(navigateTo).toHaveBeenCalledWith(URL));
  });

  it("tries a new window when the host refuses", async () => {
    const open = vi.fn();
    vi.stubGlobal("window", { open });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    navigateTo.mockResolvedValue({ ok: false, error: new Error("PermissionDenied") });
    openExternal(URL);
    await vi.waitFor(() => expect(open).toHaveBeenCalledWith(URL, "_blank", "noopener,noreferrer"));
  });
});
