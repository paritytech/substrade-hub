import {
  encodeFunctionData,
  decodeFunctionResult,
  type Abi,
  type ContractFunctionName,
  type ContractFunctionArgs,
} from "viem";
import { fromHex, toHex } from "polkadot-api/utils";
import { getTypedApi } from "./client";
import { revertError } from "./errors";
import { sendTransaction, waitForFinality, waitForReceipt } from "./wallet";
import type { TxStep } from "./tx-progress";
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
 * The error for a failed `ReviveApi.eth_transact`: its error is `{ type: "Data", value: <revert data> }`
 * for a contract revert, or `{ type: "Message", value: <text> }` for a failure outside the contract
 * (kept internal).
 */
function ethTransactError(error: unknown, abi: Abi): Error {
  const e = error as { type?: string; value?: unknown };
  if (e?.type === "Data") {
    const v = e.value as Uint8Array | { asBytes?: () => Uint8Array };
    const data = v instanceof Uint8Array ? v : v?.asBytes?.();
    return revertError({ value: { data } }, abi);
  }
  return new Error(`eth_transact failed: ${typeof e?.value === "string" ? e.value : JSON.stringify(error)}`);
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
    throw ethTransactError(result.value, abi);
  }

  return decodeFunctionResult({
    abi,
    functionName,
    data: toHex(result.value.data) as `0x${string}`,
  } as never);
}

/**
 * Simulate a state-changing contract call (an `eth_transact` dry-run) and return its decoded return
 * value, without submitting. Node-side, so it is account-type-agnostic. A contract revert surfaces via
 * `revertError`. Unlike a cached view (e.g. `getBestPrices`), this runs the call for real, so
 * it reflects execution-time effects like lazy order expiry during matching.
 */
export async function simulateContract<
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
  const api = getTypedApi();
  const callData = encodeFunctionData({ abi, functionName, args } as never);
  const tx = buildEthTransactTx(contractAddress, callData, from, options?.value);

  const result = await api.apis.ReviveApi.eth_transact(tx, { at: "best" });

  if (!result.success) {
    throw ethTransactError(result.value, abi);
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
  options?: { value?: bigint; onProgress?: (step: TxStep) => void },
): Promise<{ txHash: string; status: "success" }> {
  const callData = encodeFunctionData({ abi, functionName, args } as never);

  const { accountType, ss58, signer, mapped, h160, setMapped } = useWalletStore.getState();

  // Substrate and host accounts drive the same contract via a signed `pallet_revive.call` extrinsic.
  // Host accounts are marked mapped (handled host-side), so they skip the ensureMapped probe.
  if ((accountType === "substrate" || accountType === "host") && ss58 && signer) {
    if (!mapped && h160) {
      await ensureMapped(h160, signer);
      setMapped();
    }
    console.log(`[writeContract] ${String(functionName)} via pallet_revive.call (${accountType})`);
    return submitReviveCall({
      abi: abi as Abi,
      contractAddress,
      callData,
      originSs58: ss58,
      signer,
      value: options?.value,
      onProgress: options?.onProgress,
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
  // MetaMask signs and broadcasts in one step, so the first step reported is "submitted".
  const onProgress = options?.onProgress;
  onProgress?.("submitted");
  const receipt = await waitForReceipt(txHash); // throws on revert / timeout
  onProgress?.("in-block");
  if (onProgress) {
    void waitForFinality(receipt.blockNumber).then((finalized) => {
      if (finalized) onProgress("finalized");
    });
  }
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
