import {
  encodeFunctionData,
  decodeFunctionResult,
  type Abi,
  type ContractFunctionName,
  type ContractFunctionArgs,
} from "viem";
import { Binary } from "polkadot-api";
import { getTypedApi } from "./client";
import { extractRevertReason } from "./errors";
import { sendTransaction, waitForReceipt } from "./wallet";

function buildEthTransactTx(
  contractAddress: `0x${string}`,
  callData: `0x${string}`,
  from?: `0x${string}`,
  value?: bigint,
) {
  return {
    to: Binary.fromHex(contractAddress),
    input: { data: Binary.fromHex(callData) },
    value: value != null ? toU256(value) : undefined,
    from: from ? Binary.fromHex(from) : undefined,
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
    data: result.value.data.asHex() as `0x${string}`,
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
) {
  const callData = encodeFunctionData({ abi, functionName, args } as never);

  const txHash = await sendTransaction({
    to: contractAddress,
    data: callData,
    from,
    value: options?.value,
  });

  console.log(`[writeContract] ${String(functionName)} tx: ${txHash}`);
  return waitForReceipt(txHash);
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
