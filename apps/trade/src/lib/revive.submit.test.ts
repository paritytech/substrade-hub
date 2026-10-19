import { vi, describe, it, expect, beforeEach } from "vitest";
import type { PolkadotSigner } from "polkadot-api";
import type { Abi } from "viem";

// Controllable fake typed API, injected in place of the real PAPI client.
const { mockApi } = vi.hoisted(() => ({ mockApi: {} as Record<string, any> }));
vi.mock("./client", () => ({ getTypedApi: () => mockApi }));
// The revert decoder is exercised in errors.ts' own tests; here we only assert it is invoked.
vi.mock("./errors", async () => {
  const { UserFacingError } = await import("./user-errors");
  return { revertError: () => new UserFacingError("decoded-revert-reason") };
});

import { UserFacingError } from "./user-errors";
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

// A fake `signSubmitAndWatch` observable that synchronously emits the given PAPI-shaped events, then
// optionally fails the subscription.
const watch = (events: Record<string, any>[], fail?: unknown) => ({
  signSubmitAndWatch: () => ({
    subscribe: (o: { next: (e: any) => void; error: (e: any) => void }) => {
      for (const e of events) o.next(e);
      if (fail !== undefined) o.error(fail);
      return { unsubscribe: () => {} };
    },
  }),
});

const submit = () =>
  submitReviveCall({ abi: ABI, contractAddress: CONTRACT, callData: CALLDATA, originSs58: "5A", signer });

describe("submitReviveCall", () => {
  it("submits Revive.call with 2x-buffered weight and storage deposit on a clean dry-run", async () => {
    mockApi.apis.ReviveApi.call.mockResolvedValue(okDry());
    mockApi.tx.Revive.call.mockReturnValue(
      watch([
        { type: "signed", txHash: "0xhash" },
        { type: "txBestBlocksState", txHash: "0xhash", found: true, ok: true, block: { hash: "0xblk" }, events: [] },
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
    expect(arg.weight_limit).toEqual({ ref_time: 2000n, proof_size: 4000n }); // 2x weight buffer
    expect(arg.storage_deposit_limit).toBe(5000n); // 500n * 10 storage buffer
    expect(arg.value).toBe(0n);
  });

  it("reports each step, from signed to finalized", async () => {
    mockApi.apis.ReviveApi.call.mockResolvedValue(okDry());
    const included = { txHash: "0xh", ok: true, block: { hash: "0xb", number: 1, index: 0 }, events: [] };
    mockApi.tx.Revive.call.mockReturnValue(
      watch([
        { type: "signed", txHash: "0xh" },
        { type: "broadcasted", txHash: "0xh" },
        { type: "txBestBlocksState", found: true, ...included },
        { type: "finalized", ...included },
      ]),
    );
    const steps: string[] = [];
    await submitReviveCall({
      abi: ABI,
      contractAddress: CONTRACT,
      callData: CALLDATA,
      originSs58: "5A",
      signer,
      onProgress: (step) => steps.push(step),
    });
    expect(steps).toEqual(["signed", "submitted", "in-block", "finalized"]);
  });

  it("defaults value to 0n and passes a provided native value to the dry-run and the extrinsic", async () => {
    mockApi.apis.ReviveApi.call.mockResolvedValue(okDry());
    mockApi.tx.Revive.call.mockReturnValue(
      watch([
        { type: "signed", txHash: "0xh" },
        { type: "txBestBlocksState", txHash: "0xh", found: true, ok: true, block: { hash: "0xb" }, events: [] },
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

  it("dry-runs at the best block, where the previous write already landed", async () => {
    mockApi.apis.ReviveApi.call.mockResolvedValue(okDry());
    mockApi.tx.Revive.call.mockReturnValue(
      watch([
        { type: "signed", txHash: "0xhash" },
        { type: "txBestBlocksState", txHash: "0xhash", found: true, ok: true, block: { hash: "0xblk" }, events: [] },
      ]),
    );
    await submit();
    expect(mockApi.apis.ReviveApi.call.mock.calls[0]![6]).toEqual({ at: "best" });
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
    expect(await result).toMatch(/didn't include the transaction in time/i);
    vi.useRealTimers();
  });

  it("throws the contract's user-facing error and never submits when the dry-run flags a revert", async () => {
    mockApi.apis.ReviveApi.call.mockResolvedValue(
      okDry({ result: { success: true, value: { flags: 1, data: new Uint8Array([1, 2, 3]) } } }),
    );
    await expect(
      submitReviveCall({ abi: ABI, contractAddress: CONTRACT, callData: CALLDATA, originSs58: "5A", signer }),
    ).rejects.toThrow("decoded-revert-reason");
    expect(mockApi.tx.Revive.call).not.toHaveBeenCalled();
  });

  it("throws 'No contract code' and never submits when the dry-run requires zero weight (empty address)", async () => {
    // A successful, non-revert dry-run that needs zero weight = the destination has no contract code,
    // so the call would be a silent no-op that pallet-revive reports as success. Fail loudly instead.
    mockApi.apis.ReviveApi.call.mockResolvedValue(okDry({ weight_required: weight(0n, 0n) }));
    await expect(
      submitReviveCall({ abi: ABI, contractAddress: CONTRACT, callData: CALLDATA, originSs58: "5A", signer }),
    ).rejects.toThrow(/No contract code/i);
    expect(mockApi.tx.Revive.call).not.toHaveBeenCalled();
  });

  it("throws an internal (not user-facing) error on an unexplained dispatch-level dry-run failure", async () => {
    mockApi.apis.ReviveApi.call.mockResolvedValue(
      okDry({ result: { success: false, value: { type: "Module" } } }),
    );
    await expect(
      submitReviveCall({ abi: ABI, contractAddress: CONTRACT, callData: CALLDATA, originSs58: "5A", signer }),
    ).rejects.toSatisfy((e: unknown) => !(e instanceof UserFacingError) && /dry-run failed/.test((e as Error).message));
    expect(mockApi.tx.Revive.call).not.toHaveBeenCalled();
  });

  it("reports a dispatch error the user can act on (not enough funds) in plain words", async () => {
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
    ).rejects.toThrow(/Not enough balance to pay for this transaction/);
  });

  it("reports a BadProof validity error as a rejected signature, without its internals", async () => {
    mockApi.apis.ReviveApi.call.mockResolvedValue(okDry());
    const invalid = Object.assign(new Error("Invalid"), {
      name: "InvalidTxError",
      error: { type: "Invalid", value: { type: "BadProof" } },
    });
    mockApi.tx.Revive.call.mockReturnValue(watch([{ type: "signed", txHash: "0xh" }], invalid));
    const err = await submit().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UserFacingError);
    expect((err as Error).message).toMatch(/rejected your wallet's signature/);
    expect((err as Error).message).not.toMatch(/BadProof/);
  });

  it("reports a rejected signing request as cancelled", async () => {
    mockApi.apis.ReviveApi.call.mockResolvedValue(okDry());
    mockApi.tx.Revive.call.mockReturnValue(watch([], new Error("User rejected the request")));
    await expect(submit()).rejects.toThrow("Signing was cancelled.");
  });
});

describe("ensureMapped", () => {
  const included = (ok: boolean, dispatchError?: unknown) =>
    watch([
      { type: "signed", txHash: "0xh" },
      { type: "txBestBlocksState", txHash: "0xh", found: true, ok, block: { hash: "0xblk" }, events: [], dispatchError },
    ]);

  it("no-ops when the account is already mapped", async () => {
    mockApi.query.Revive.OriginalAccount.getValue.mockResolvedValue("5Alice");
    await ensureMapped(H160, signer);
    expect(mockApi.tx.Revive.map_account).not.toHaveBeenCalled();
  });

  it("submits map_account when unmapped", async () => {
    mockApi.query.Revive.OriginalAccount.getValue.mockResolvedValue(undefined);
    mockApi.tx.Revive.map_account.mockReturnValue(included(true));
    await ensureMapped(H160, signer);
    expect(mockApi.tx.Revive.map_account).toHaveBeenCalledOnce();
  });

  it("swallows an AccountAlreadyMapped race", async () => {
    mockApi.query.Revive.OriginalAccount.getValue.mockResolvedValue(undefined);
    mockApi.tx.Revive.map_account.mockReturnValue(
      included(false, { type: "Module", value: { type: "Revive", value: { type: "AccountAlreadyMapped" } } }),
    );
    await expect(ensureMapped(H160, signer)).resolves.toBeUndefined();
  });

  it("reports a cancelled signature and too little balance like a contract call", async () => {
    mockApi.query.Revive.OriginalAccount.getValue.mockResolvedValue(undefined);
    mockApi.tx.Revive.map_account.mockReturnValue(watch([], new Error("User rejected the request")));
    await expect(ensureMapped(H160, signer)).rejects.toThrow("Signing was cancelled.");

    mockApi.tx.Revive.map_account.mockReturnValue(included(false, { type: "Token", value: { type: "FundsUnavailable" } }));
    await expect(ensureMapped(H160, signer)).rejects.toThrow(/Not enough balance/);
  });

  it("keeps any other map_account failure internal", async () => {
    mockApi.query.Revive.OriginalAccount.getValue.mockResolvedValue(undefined);
    mockApi.tx.Revive.map_account.mockReturnValue(included(false, { type: "Other" }));
    const err = await ensureMapped(H160, signer).catch((e: unknown) => e);
    expect(err).not.toBeInstanceOf(UserFacingError);
  });
});

describe("submitReviveCall chain errors", () => {
  it("reports a stale nonce as a pending transaction", async () => {
    mockApi.apis.ReviveApi.call.mockResolvedValue(okDry());
    const stale = Object.assign(new Error("Invalid"), {
      name: "InvalidTxError",
      error: { type: "Invalid", value: { type: "Stale" } },
    });
    mockApi.tx.Revive.call.mockReturnValue(watch([{ type: "signed", txHash: "0xh" }], stale));
    await expect(submit()).rejects.toThrow(/previous transaction is still pending/);
  });

  it("reports an unmapped account as one to fund first", async () => {
    mockApi.apis.ReviveApi.call.mockResolvedValue(
      okDry({ result: { success: false, value: { type: "Module", value: { type: "Revive", value: { type: "AccountUnmapped" } } } } }),
    );
    await expect(submit()).rejects.toThrow(/not set up on this network yet/);
  });

  it("keeps an unexplained dispatch error internal", async () => {
    mockApi.apis.ReviveApi.call.mockResolvedValue(okDry());
    mockApi.tx.Revive.call.mockReturnValue(
      watch([
        { type: "signed", txHash: "0xh" },
        { type: "txBestBlocksState", found: true, ok: false, dispatchError: { type: "BadOrigin" } },
      ]),
    );
    const err = await submit().catch((e: unknown) => e);
    expect(err).not.toBeInstanceOf(UserFacingError);
    expect((err as Error).message).toBe("Transaction failed: BadOrigin");
  });
});
