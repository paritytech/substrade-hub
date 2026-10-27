// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: © 2026 Parity Technologies
import { vi, describe, it, expect, beforeEach } from "vitest";

// One controllable SignerManager instance behind the mocked constructor. `new SignerManager()` returns
// `manager` because a constructor returning an object yields that object.
const { manager } = vi.hoisted(() => ({
  manager: { connect: vi.fn(), selectAccount: vi.fn(), getSigner: vi.fn() },
}));
vi.mock("../../config/chains", () => ({ activeChain: { dotnsName: "substrade-hub.testnet" } }));
const { hostApi } = vi.hoisted(() => ({ hostApi: { getAccountsProvider: vi.fn() } }));
vi.mock("@parity/product-sdk-host", () => ({
  getAccountsProvider: hostApi.getAccountsProvider,
  formatHostError: (e: unknown) => String(e),
}));
vi.mock("@parity/product-sdk-signer", () => ({
  SignerManager: vi.fn(function () {
    return manager;
  }),
}));

import {
  connectHostAccounts,
  selectHostAccount,
  getHostSigner,
  requestHostLogin,
  getHostUsername,
  CONNECT_TIMEOUT_MS,
} from "./signer";
import { SignerManager } from "@parity/product-sdk-signer";

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

  it("shares one attempt between overlapping callers, and connects anew afterwards", async () => {
    let release!: (v: unknown) => void;
    manager.connect.mockReturnValueOnce(new Promise((r) => (release = r)));
    const first = connectHostAccounts();
    const second = connectHostAccounts();
    release({ ok: true, value: [] });
    await expect(Promise.all([first, second])).resolves.toEqual([[], []]);
    expect(manager.connect).toHaveBeenCalledTimes(1);

    manager.connect.mockResolvedValue({ ok: true, value: [] });
    await connectHostAccounts();
    expect(manager.connect).toHaveBeenCalledTimes(2);
  });

  it("gives up on a host that does not answer, and lets the next call start afresh", async () => {
    vi.useFakeTimers();
    try {
      manager.connect.mockReturnValueOnce(new Promise(() => {}));
      const stuck = connectHostAccounts();
      const assertion = expect(stuck).rejects.toThrow(/did not respond/);
      await vi.advanceTimersByTimeAsync(CONNECT_TIMEOUT_MS);
      await assertion;

      manager.connect.mockResolvedValue({ ok: true, value: [] });
      await expect(connectHostAccounts()).resolves.toEqual([]);
      expect(manager.connect).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});

/** A host `requestLogin` result, shaped like neverthrow's ResultAsync `match`. */
function loginResult(outcome: { ok: string } | { err: string }) {
  return {
    match: (onOk: (v: string) => unknown, onErr: (e: string) => unknown) =>
      Promise.resolve().then(() => ("ok" in outcome ? onOk(outcome.ok) : onErr(outcome.err))),
  };
}

describe("requestHostLogin", () => {
  beforeEach(() => hostApi.getAccountsProvider.mockReset());

  it("asks the host to sign in, with the app's reason, and reports a session", async () => {
    const requestLogin = vi.fn(() => loginResult({ ok: "Success" }));
    hostApi.getAccountsProvider.mockResolvedValue({ requestLogin });
    await expect(requestHostLogin()).resolves.toBe(true);
    expect(requestLogin).toHaveBeenCalledWith(expect.stringContaining("SubsTrade Hub"));
  });

  it("treats an existing session as signed in", async () => {
    hostApi.getAccountsProvider.mockResolvedValue({ requestLogin: () => loginResult({ ok: "AlreadyConnected" }) });
    await expect(requestHostLogin()).resolves.toBe(true);
  });

  it("reports a declined sign-in", async () => {
    hostApi.getAccountsProvider.mockResolvedValue({ requestLogin: () => loginResult({ ok: "Rejected" }) });
    await expect(requestHostLogin()).resolves.toBe(false);
  });

  it("throws when the host fails the request or is unavailable", async () => {
    hostApi.getAccountsProvider.mockResolvedValue({ requestLogin: () => loginResult({ err: "Unsupported" }) });
    await expect(requestHostLogin()).rejects.toThrow("Host sign-in failed: Unsupported");
    hostApi.getAccountsProvider.mockResolvedValue(null);
    await expect(requestHostLogin()).rejects.toThrow(/not available/);
  });
});

/** A host `getUserId` result, shaped like neverthrow's ResultAsync `match`. */
function userIdResult(outcome: { ok: { primaryUsername: string } } | { err: string }) {
  return {
    match: (onOk: (v: { primaryUsername: string }) => unknown, onErr: (e: string) => unknown) =>
      Promise.resolve().then(() => ("ok" in outcome ? onOk(outcome.ok) : onErr(outcome.err))),
  };
}

describe("getHostUsername", () => {
  beforeEach(() => hostApi.getAccountsProvider.mockReset());

  it("returns the signed-in user's username", async () => {
    hostApi.getAccountsProvider.mockResolvedValue({
      getUserId: () => userIdResult({ ok: { primaryUsername: " giuseppe.dot " } }),
    });
    await expect(getHostUsername()).resolves.toBe("giuseppe.dot");
  });

  it("returns null for an empty username, so the address is shown", async () => {
    hostApi.getAccountsProvider.mockResolvedValue({ getUserId: () => userIdResult({ ok: { primaryUsername: "" } }) });
    await expect(getHostUsername()).resolves.toBeNull();
  });

  it("returns null when the host fails or is unavailable", async () => {
    hostApi.getAccountsProvider.mockResolvedValue({ getUserId: () => userIdResult({ err: "NotConnected" }) });
    await expect(getHostUsername()).resolves.toBeNull();
    hostApi.getAccountsProvider.mockResolvedValue(null);
    await expect(getHostUsername()).resolves.toBeNull();
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

  it("returns the tx creator when available", () => {
    const signer = { sentinel: true };
    manager.getSigner.mockReturnValue(signer);
    expect(getHostSigner()).toBe(signer);
  });
});

describe("product identity", () => {
  it("uses the network's dotNS name as the SignerManager dappName", async () => {
    manager.connect.mockResolvedValue({ ok: true, value: [] });
    await connectHostAccounts(); // triggers lazy getManager()
    expect(vi.mocked(SignerManager)).toHaveBeenCalled();
    expect(vi.mocked(SignerManager).mock.calls[0]![0]).toMatchObject({
      dappName: "substrade-hub.testnet",
    });
  });
});
