// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: © 2026 Parity Technologies
import { vi, describe, it, expect, beforeEach } from "vitest";
import { AccountId } from "polkadot-api";
import { fromHex } from "polkadot-api/utils";
import type { TxCreator } from "polkadot-api";

// Mock the two submission backends and the EVM wallet so we can assert which path writeContract takes.
vi.mock("./revive", () => ({
  submitReviveCall: vi.fn().mockResolvedValue({ txHash: "0xsubstrate", status: "success" }),
  ensureMapped: vi.fn().mockResolvedValue(undefined),
  dryRunCall: vi.fn().mockResolvedValue({}),
}));
vi.mock("./wallet", () => ({
  sendTransaction: vi.fn().mockResolvedValue("0xevmhash"),
  waitForReceipt: vi.fn().mockResolvedValue({
    status: "0x1",
    blockNumber: "0x10",
    logs: [{ address: "0x00000000000000000000000000000000000000aa", topics: ["0x01"], data: "0x02" }],
  }),
  waitForFinality: vi.fn().mockResolvedValue(true),
}));

import { writeContract } from "./contract";
import { erc20Abi } from "../abi/erc20";
import { useWalletStore } from "../stores/wallet";
import { useHostConnectionStore } from "../stores/host-connection";
import { submitReviveCall, ensureMapped, dryRunCall } from "./revive";
import { UserFacingError } from "./user-errors";
import { sendTransaction, waitForFinality } from "./wallet";

const EVM = "0x1234567890abcdef1234567890abcdef12345678" as const;
const SUB = {
  extensionName: "polkadot-js",
  ss58: "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY",
  h160: "0x9621dde636de098b43efb0fa9b61facfe328f99d" as const,
  originAccount: "0xd43593c715fdd31c61141abd04a99fd6822c8558854ccde39a5684e7a56da27d" as const,
  signer: {} as TxCreator,
};
const TOKEN = "0x000007c000000000000000000000000001200000" as const;
const args = [EVM, 1000n] as const; // approve(spender, amount)

beforeEach(() => {
  vi.clearAllMocks();
  useWalletStore.getState().disconnect();
  useHostConnectionStore.setState({ connection: "ok", everConnected: false });
});

describe("writeContract routing", () => {
  it("refuses to submit while the host connection is down", async () => {
    useWalletStore.getState().connectSubstrate(SUB);
    for (const connection of ["lost", "reconnecting"] as const) {
      useHostConnectionStore.setState({ connection, everConnected: true });
      await expect(writeContract(erc20Abi, "approve", args, TOKEN, SUB.h160)).rejects.toThrow(
        new UserFacingError("The connection to the host is lost. Try again once it is back."),
      );
    }
    expect(submitReviveCall).not.toHaveBeenCalled();
    expect(ensureMapped).not.toHaveBeenCalled();
  });

  it("routes EVM accounts through eth_sendTransaction (regression: EVM path unchanged)", async () => {
    useWalletStore.getState().connectEvm(EVM);
    const res = await writeContract(erc20Abi, "approve", args, TOKEN, EVM);
    expect(sendTransaction).toHaveBeenCalledOnce();
    expect(submitReviveCall).not.toHaveBeenCalled();
    expect(res).toEqual({
      txHash: "0xevmhash",
      status: "success",
      logs: [{ address: "0x00000000000000000000000000000000000000aa", topics: ["0x01"], data: "0x02" }],
    });
  });

  it("reports the EVM steps: submitted, included, then finalized once the block is", async () => {
    useWalletStore.getState().connectEvm(EVM);
    const steps: string[] = [];
    await writeContract(erc20Abi, "approve", args, TOKEN, EVM, { onProgress: (s) => steps.push(s) });
    expect(steps.slice(0, 2)).toEqual(["submitted", "in-block"]);
    await vi.waitFor(() => expect(steps).toEqual(["submitted", "in-block", "finalized"]));
    expect(waitForFinality).toHaveBeenCalledWith("0x10");
  });

  it("routes Substrate accounts through submitReviveCall, mapping first when unmapped", async () => {
    useWalletStore.getState().connectSubstrate(SUB);
    const res = await writeContract(erc20Abi, "approve", args, TOKEN, SUB.h160);
    expect(ensureMapped).toHaveBeenCalledOnce();
    expect(submitReviveCall).toHaveBeenCalledOnce();
    expect(sendTransaction).not.toHaveBeenCalled();
    // the signer and dry-run origin come from the store
    const firstCall = vi.mocked(submitReviveCall).mock.calls[0];
    expect(firstCall).toBeDefined();
    expect(firstCall![0]).toMatchObject({
      originSs58: SUB.ss58,
      signer: SUB.signer,
      contractAddress: TOKEN,
    });
    expect(res).toEqual({ txHash: "0xsubstrate", status: "success" });
  });

  it("skips ensureMapped when the account is already mapped", async () => {
    useWalletStore.getState().connectSubstrate(SUB);
    useWalletStore.getState().setMapped();
    await writeContract(erc20Abi, "approve", args, TOKEN, SUB.h160);
    expect(ensureMapped).not.toHaveBeenCalled();
    expect(submitReviveCall).toHaveBeenCalledOnce();
  });

  it("routes host accounts through submitReviveCall, no ensureMapped (host maps)", async () => {
    useWalletStore.getState().connectHost({
      ss58: SUB.ss58,
      h160: SUB.h160,
      originAccount: SUB.originAccount,
      signer: SUB.signer,
    });
    const res = await writeContract(erc20Abi, "approve", args, TOKEN, SUB.h160);
    expect(ensureMapped).not.toHaveBeenCalled();
    expect(submitReviveCall).toHaveBeenCalledOnce();
    expect(sendTransaction).not.toHaveBeenCalled();
    expect(vi.mocked(submitReviveCall).mock.calls[0]![0]).toMatchObject({
      originSs58: SUB.ss58,
      signer: SUB.signer,
    });
    expect(res).toEqual({ txHash: "0xsubstrate", status: "success" });
  });

  it("dry-runs an EVM write as the EVM address's mapped account before asking MetaMask", async () => {
    useWalletStore.getState().connectEvm(EVM);
    await writeContract(erc20Abi, "approve", args, TOKEN, EVM);
    const [origin, dest] = vi.mocked(dryRunCall).mock.calls.at(-1)!;
    expect(origin).toBe(AccountId().dec(fromHex(`${EVM}${"ee".repeat(12)}`)));
    expect(dest).toBe(TOKEN);
  });

  it("stops before MetaMask when the dry run refuses the call", async () => {
    useWalletStore.getState().connectEvm(EVM);
    vi.mocked(sendTransaction).mockClear();
    vi.mocked(dryRunCall).mockRejectedValueOnce(new UserFacingError("This order crosses too many price levels"));
    await expect(writeContract(erc20Abi, "approve", args, TOKEN, EVM)).rejects.toThrow(/too many price levels/);
    expect(sendTransaction).not.toHaveBeenCalled();
  });
});
