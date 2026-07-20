import {
  encodeFunctionData,
  decodeFunctionResult,
  type Abi,
  type ContractFunctionName,
  type ContractFunctionArgs,
} from "viem";
import { fromHex, toHex } from "polkadot-api/utils";
import { getTypedApi } from "./client";
import { extractRevertReason } from "./errors";
import { sendTransaction, waitForReceipt } from "./wallet";
import { useWalletStore } from "../stores/wallet";
import { submitReviveCall, ensureMapped } from "./revive";

function buildEthTransactTx(
  contractAddress: `0x${string}`,
  callData: `0x${string}`,
  from?: `0x${string}`,
  value?: bigint,
) {
  return {
    to: contractAddress,
    input: { data: fromHex(callData) },
    value: value != null ? toU256(value) : undefined,
    from,
    authorization_list: [],
    blob_versioned_hashes: [],
    blobs: [],
    gas_price: undefined,
    nonce: undefined,
    access_list: undefined,
    chain_id: undefined,
    gas: undefined,
    max_fee_per_blob_gas: undefined,
    max_fee_per_gas: undefined,
    max_priority_fee_per_gas: undefined,
    "r#type": undefined,
  };
}

/**
 * Read from a contract using ReviveApi.eth_transact dry-run.
 */
export async function readContract<
  TAbi extends Abi,
  TFn extends ContractFunctionName<TAbi, "pure" | "view">,
>(
  abi: TAbi,
  functionName: TFn,
  args: ContractFunctionArgs<TAbi, "pure" | "view", TFn>,
  contractAddress: `0x${string}`,
) {
  const api = getTypedApi();
  const callData = encodeFunctionData({ abi, functionName, args } as never);
  const tx = buildEthTransactTx(contractAddress, callData);

  const result = await api.apis.ReviveApi.eth_transact(tx, { at: "best" });

  if (!result.success) {
    throw new Error(extractRevertReason(result as never, abi));
  }

  return decodeFunctionResult({
    abi,
    functionName,
    data: toHex(result.value.data) as `0x${string}`,
  } as never);
}

/**
 * Write to a contract via MetaMask (eth_sendTransaction through eth-rpc proxy).
 */
export async function writeContract<
  TAbi extends Abi,
  TFn extends ContractFunctionName<TAbi, "nonpayable" | "payable">,
>(
  abi: TAbi,
  functionName: TFn,
  args: ContractFunctionArgs<TAbi, "nonpayable" | "payable", TFn>,
  contractAddress: `0x${string}`,
  from: `0x${string}`,
  options?: { value?: bigint },
): Promise<{ txHash: string; status: "success" }> {
  const callData = encodeFunctionData({ abi, functionName, args } as never);

  const { accountType, ss58, signer, mapped, h160, setMapped } = useWalletStore.getState();

  // Substrate accounts drive the same contract via a signed `pallet_revive.call` extrinsic.
  if (accountType === "substrate" && ss58 && signer) {
    if (!mapped && h160) {
      await ensureMapped(h160, signer);
      setMapped();
    }
    console.log(`[writeContract] ${String(functionName)} via pallet_revive.call (substrate)`);
    return submitReviveCall({
      abi: abi as Abi,
      contractAddress,
      callData,
      originSs58: ss58,
      signer,
      value: options?.value,
    });
  }

  // EVM path (unchanged behaviour): MetaMask eth_sendTransaction + receipt polling.
  const txHash = await sendTransaction({
    to: contractAddress,
    data: callData,
    from,
    value: options?.value,
  });

  console.log(`[writeContract] ${String(functionName)} tx: ${txHash}`);
  await waitForReceipt(txHash); // throws on revert / timeout
  return { txHash, status: "success" };
}

/**
 * Convert a bigint to a U256 tuple [low, mid_low, mid_high, high] (4x u64).
 */
function toU256(value: bigint): [bigint, bigint, bigint, bigint] {
  const mask = (1n << 64n) - 1n;
  return [
    value & mask,
    (value >> 64n) & mask,
    (value >> 128n) & mask,
    (value >> 192n) & mask,
  ];
}
