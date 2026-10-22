// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: © 2026 Parity Technologies
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Controllable stand-in for the SDK's container check.
const { insideContainer } = vi.hoisted(() => ({ insideContainer: { value: false } }));
vi.mock("@parity/product-sdk-host", () => ({
  isInsideContainerSync: () => insideContainer.value,
}));

import { isInHost } from "./detect";

beforeEach(() => {
  insideContainer.value = false;
  vi.stubGlobal("window", {});
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("isInHost", () => {
  it("is false in a plain browser tab (not in a container)", () => {
    insideContainer.value = false;
    expect(isInHost()).toBe(false);
  });

  it("is true when the SDK reports a host container", () => {
    insideContainer.value = true;
    expect(isInHost()).toBe(true);
  });

  it("is false when VITE_USE_HOST_API is 'false', even inside a container", () => {
    insideContainer.value = true;
    vi.stubEnv("VITE_USE_HOST_API", "false");
    expect(isInHost()).toBe(false);
  });

  it("is false (no throw) when window is undefined", () => {
    vi.unstubAllGlobals();
    // @ts-expect-error simulate SSR / non-browser
    delete globalThis.window;
    expect(isInHost()).toBe(false);
  });
});
