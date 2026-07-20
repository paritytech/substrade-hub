import { vi, describe, it, expect, beforeEach } from "vitest";
import type { PolkadotSigner } from "polkadot-api";

// Mock the two submission backends and the EVM wallet so we can assert which path writeContract takes.
vi.mock("./revive", () => ({
  submitReviveCall: vi.fn().mockResolvedValue({ txHash: "0xsubstrate", status: "success" }),
  ensureMapped: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("./wallet", () => ({
  sendTransaction: vi.fn().mockResolvedValue("0xevmhash"),
  waitForReceipt: vi.fn().mockResolvedValue({ status: "0x1" }),
}));

import { writeContract } from "./contract";
import { erc20Abi } from "../abi/erc20";
import { useWalletStore } from "../stores/wallet";
import { submitReviveCall, ensureMapped } from "./revive";
import { sendTransaction } from "./wallet";

const EVM = "0x1234567890abcdef1234567890abcdef12345678" as const;
const SUB = {
  extensionName: "polkadot-js",
  ss58: "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY",
  h160: "0x9621dde636de098b43efb0fa9b61facfe328f99d" as const,
  originAccount: "0xd43593c715fdd31c61141abd04a99fd6822c8558854ccde39a5684e7a56da27d" as const,
  signer: {} as PolkadotSigner,
};
const TOKEN = "0x000007c000000000000000000000000001200000" as const;
const args = [EVM, 1000n] as const; // approve(spender, amount)

beforeEach(() => {
  vi.clearAllMocks();
  useWalletStore.getState().disconnect();
});

describe("writeContract routing", () => {
  it("routes EVM accounts through eth_sendTransaction (regression: EVM path unchanged)", async () => {
    useWalletStore.getState().connectEvm(EVM);
    const res = await writeContract(erc20Abi, "approve", args, TOKEN, EVM);
    expect(sendTransaction).toHaveBeenCalledOnce();
    expect(submitReviveCall).not.toHaveBeenCalled();
    expect(res).toEqual({ txHash: "0xevmhash", status: "success" });
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
});
