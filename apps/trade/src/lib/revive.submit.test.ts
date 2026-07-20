import { vi, describe, it, expect, beforeEach } from "vitest";
import type { PolkadotSigner } from "polkadot-api";
import type { Abi } from "viem";

// Controllable fake typed API, injected in place of the real PAPI client.
const { mockApi } = vi.hoisted(() => ({ mockApi: {} as Record<string, any> }));
vi.mock("./client", () => ({ getTypedApi: () => mockApi }));
// The revert decoder is exercised in errors.ts' own tests; here we only assert it is invoked.
vi.mock("./errors", () => ({ extractRevertReason: () => "decoded-revert-reason" }));

import { submitReviveCall, ensureMapped } from "./revive";

const signer = {} as PolkadotSigner;
const ABI = [] as unknown as Abi;
const CONTRACT = "0x00000000000000000000000000000000000000aa" as const;
const CALLDATA = "0x12345678" as const;
const H160 = "0x9621dde636de098b43efb0fa9b61facfe328f99d" as const;
const weight = (ref = 1000n, proof = 2000n) => ({ ref_time: ref, proof_size: proof });

beforeEach(() => {
  mockApi.apis = { ReviveApi: { call: vi.fn(), address: vi.fn() } };
  mockApi.tx = { Revive: { call: vi.fn(), map_account: vi.fn() } };
  mockApi.query = { Revive: { OriginalAccount: { getValue: vi.fn() } } };
});

const okDry = (over: Record<string, any> = {}) => ({
  weight_required: weight(1000n, 2000n),
  storage_deposit: { type: "Charge", value: 500n },
  result: { success: true, value: { flags: 0, data: new Uint8Array() } },
  ...over,
});

// A fake `signSubmitAndWatch` observable that synchronously emits the given PAPI-shaped events.
const watch = (events: Record<string, any>[]) => ({
  signSubmitAndWatch: () => ({
    subscribe: (o: { next: (e: any) => void; error: (e: any) => void }) => {
      for (const e of events) o.next(e);
      return { unsubscribe: () => {} };
    },
  }),
});

describe("submitReviveCall", () => {
  it("submits Revive.call with 2x-buffered weight and storage deposit on a clean dry-run", async () => {
    mockApi.apis.ReviveApi.call.mockResolvedValue(okDry());
    mockApi.tx.Revive.call.mockReturnValue(
      watch([
        { type: "signed", txHash: "0xhash" },
        { type: "txBestBlocksState", found: true, ok: true, block: { hash: "0xblk" } },
      ]),
    );

    const res = await submitReviveCall({
      abi: ABI,
      contractAddress: CONTRACT,
      callData: CALLDATA,
      originSs58: "5Alice",
      signer,
    });

    expect(res).toEqual({ txHash: "0xhash", status: "success" });
    const arg = mockApi.tx.Revive.call.mock.calls[0][0];
    expect(arg.weight_limit).toEqual({ ref_time: 2000n, proof_size: 4000n });
    expect(arg.storage_deposit_limit).toBe(1000n); // 500n * 2 buffer
    expect(arg.value).toBe(0n);
  });

  it("defaults value to 0n and passes a provided native value to the dry-run and the extrinsic", async () => {
    mockApi.apis.ReviveApi.call.mockResolvedValue(okDry());
    mockApi.tx.Revive.call.mockReturnValue(
      watch([
        { type: "signed", txHash: "0xh" },
        { type: "txBestBlocksState", found: true, ok: true, block: { hash: "0xb" } },
      ]),
    );
    await submitReviveCall({
      abi: ABI,
      contractAddress: CONTRACT,
      callData: CALLDATA,
      originSs58: "5A",
      signer,
      value: 123n,
    });
    // ReviveApi.call(origin, dest, value, ...) — value is the 3rd positional arg
    expect(mockApi.apis.ReviveApi.call.mock.calls[0]![2]).toBe(123n);
    expect(mockApi.tx.Revive.call.mock.calls[0]![0].value).toBe(123n);
  });

  it("rejects if the tx is submitted but never included (timeout, no hang)", async () => {
    vi.useFakeTimers();
    mockApi.apis.ReviveApi.call.mockResolvedValue(okDry());
    // Observable that emits `signed` but never reaches `txBestBlocksState`.
    mockApi.tx.Revive.call.mockReturnValue(watch([{ type: "signed", txHash: "0xh" }]));
    const result = submitReviveCall({
      abi: ABI,
      contractAddress: CONTRACT,
      callData: CALLDATA,
      originSs58: "5A",
      signer,
    }).catch((e) => (e as Error).message);
    await vi.advanceTimersByTimeAsync(31_000);
    expect(await result).toMatch(/not included within 30s/i);
    vi.useRealTimers();
  });

  it("throws the decoded revert reason and never submits when the dry-run flags a revert", async () => {
    mockApi.apis.ReviveApi.call.mockResolvedValue(
      okDry({ result: { success: true, value: { flags: 1, data: new Uint8Array([1, 2, 3]) } } }),
    );
    await expect(
      submitReviveCall({ abi: ABI, contractAddress: CONTRACT, callData: CALLDATA, originSs58: "5A", signer }),
    ).rejects.toThrow("decoded-revert-reason");
    expect(mockApi.tx.Revive.call).not.toHaveBeenCalled();
  });

  it("throws on a dispatch-level dry-run failure without submitting", async () => {
    mockApi.apis.ReviveApi.call.mockResolvedValue(
      okDry({ result: { success: false, value: { type: "Module" } } }),
    );
    await expect(
      submitReviveCall({ abi: ABI, contractAddress: CONTRACT, callData: CALLDATA, originSs58: "5A", signer }),
    ).rejects.toThrow(/dry-run failed/);
    expect(mockApi.tx.Revive.call).not.toHaveBeenCalled();
  });

  it("surfaces a formatted dispatch error when the included tx failed", async () => {
    mockApi.apis.ReviveApi.call.mockResolvedValue(okDry());
    mockApi.tx.Revive.call.mockReturnValue(
      watch([
        { type: "signed", txHash: "0xh" },
        {
          type: "txBestBlocksState",
          found: true,
          ok: false,
          dispatchError: { type: "Token", value: { type: "FundsUnavailable" } },
        },
      ]),
    );
    await expect(
      submitReviveCall({ abi: ABI, contractAddress: CONTRACT, callData: CALLDATA, originSs58: "5A", signer }),
    ).rejects.toThrow("Transaction failed: Token (FundsUnavailable)");
  });
});

describe("ensureMapped", () => {
  it("no-ops when the account is already mapped", async () => {
    mockApi.query.Revive.OriginalAccount.getValue.mockResolvedValue("5Alice");
    const signAndSubmit = vi.fn();
    mockApi.tx.Revive.map_account.mockReturnValue({ signAndSubmit });
    await ensureMapped(H160, signer);
    expect(signAndSubmit).not.toHaveBeenCalled();
  });

  it("submits map_account when unmapped", async () => {
    mockApi.query.Revive.OriginalAccount.getValue.mockResolvedValue(undefined);
    const signAndSubmit = vi.fn().mockResolvedValue({ ok: true });
    mockApi.tx.Revive.map_account.mockReturnValue({ signAndSubmit });
    await ensureMapped(H160, signer);
    expect(signAndSubmit).toHaveBeenCalledOnce();
  });

  it("swallows an AccountAlreadyMapped race", async () => {
    mockApi.query.Revive.OriginalAccount.getValue.mockResolvedValue(undefined);
    mockApi.tx.Revive.map_account.mockReturnValue({
      signAndSubmit: vi
        .fn()
        .mockResolvedValue({ ok: false, dispatchError: { type: "Module", value: { type: "AccountAlreadyMapped" } } }),
    });
    await expect(ensureMapped(H160, signer)).resolves.toBeUndefined();
  });

  it("throws on any other map_account failure", async () => {
    mockApi.query.Revive.OriginalAccount.getValue.mockResolvedValue(undefined);
    mockApi.tx.Revive.map_account.mockReturnValue({
      signAndSubmit: vi.fn().mockResolvedValue({ ok: false, dispatchError: { type: "Other" } }),
    });
    await expect(ensureMapped(H160, signer)).rejects.toThrow(/map_account failed/);
  });
});
