import { vi, describe, it, expect, beforeEach } from "vitest";

// One controllable SignerManager instance behind the mocked constructor. `new SignerManager()` returns
// `manager` because a constructor returning an object yields that object.
const { manager } = vi.hoisted(() => ({
  manager: { connect: vi.fn(), selectAccount: vi.fn(), getSigner: vi.fn() },
}));
vi.mock("@parity/product-sdk-signer", () => ({
  SignerManager: vi.fn(function () {
    return manager;
  }),
}));

import { connectHostAccounts, selectHostAccount, getHostSigner } from "./signer";

beforeEach(() => {
  manager.connect.mockReset();
  manager.selectAccount.mockReset();
  manager.getSigner.mockReset();
});

describe("connectHostAccounts", () => {
  it("returns the accounts on success", async () => {
    const accounts = [{ address: "5Grw", h160Address: "0xaa" }];
    manager.connect.mockResolvedValue({ ok: true, value: accounts });
    await expect(connectHostAccounts()).resolves.toBe(accounts);
  });

  it("throws the signer error message on failure", async () => {
    manager.connect.mockResolvedValue({ ok: false, error: { message: "host unavailable" } });
    await expect(connectHostAccounts()).rejects.toThrow("host unavailable");
  });
});

describe("selectHostAccount", () => {
  it("returns the account on success", () => {
    manager.selectAccount.mockReturnValue({ ok: true, value: { address: "5Grw" } });
    expect(selectHostAccount("5Grw")).toEqual({ address: "5Grw" });
  });

  it("throws on failure", () => {
    manager.selectAccount.mockReturnValue({ ok: false, error: { message: "not found" } });
    expect(() => selectHostAccount("5Grw")).toThrow("not found");
  });
});

describe("getHostSigner", () => {
  it("throws when no account is selected (getSigner() is null)", () => {
    manager.getSigner.mockReturnValue(null);
    expect(() => getHostSigner()).toThrow(/connect and select/i);
  });

  it("returns the PolkadotSigner when available", () => {
    const signer = { sentinel: true };
    manager.getSigner.mockReturnValue(signer);
    expect(getHostSigner()).toBe(signer);
  });
});
