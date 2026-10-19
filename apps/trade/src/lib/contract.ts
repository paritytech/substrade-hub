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
import { useHostConnectionStore } from "../stores/host-connection";
import { UserFacingError } from "./user-errors";
import { AccountId } from "polkadot-api";
import { dryRunCall, submitReviveCall, ensureMapped, type TxLog } from "./revive";

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
 * The account a simulation runs as: the connected Substrate or host account for its own H160, else the
 * account an EVM address maps to (the H160 followed by twelve 0xEE bytes).
 */
function simulationOrigin(from: `0x${string}`): string {
  const { ss58, h160 } = useWalletStore.getState();
  if (ss58 && h160?.toLowerCase() === from.toLowerCase()) return ss58;
  return AccountId().dec(fromHex(`${from}${"ee".repeat(12)}`));
}

/**
 * Simulate a state-changing contract call (a `ReviveApi.call` dry-run as `from`) and return its decoded
 * return value, without submitting. Unlike a cached view (e.g. `getBestPrices`), this runs the call for
 * real, so it reflects execution-time effects like lazy order expiry during matching. It fails the way
 * a submission would: a contract revert, or a call too large for one transaction (see `dryRunCall`).
 * `value` is in native planck.
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
  const data = await simulateContractData(abi, functionName, args, contractAddress, from, options);
  return decodeFunctionResult({ abi, functionName, data } as never);
}

/** `simulateContract`, returning the call's raw return data undecoded. */
export async function simulateContractData<
  TAbi extends Abi,
  TFn extends ContractFunctionName<TAbi, "nonpayable" | "payable">,
>(
  abi: TAbi,
  functionName: TFn,
  args: ContractFunctionArgs<TAbi, "nonpayable" | "payable", TFn>,
  contractAddress: `0x${string}`,
  from: `0x${string}`,
  options?: { value?: bigint },
): Promise<`0x${string}`> {
  const callData = encodeFunctionData({ abi, functionName, args } as never);
  const { dry } = await dryRunCall(simulationOrigin(from), contractAddress, options?.value ?? 0n, fromHex(callData), abi as Abi);
  const raw = dry.result.value as { data: Uint8Array | { asBytes(): Uint8Array } };
  const bytes = raw.data instanceof Uint8Array ? raw.data : raw.data.asBytes();
  return toHex(bytes) as `0x${string}`;
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
): Promise<{ txHash: string; status: "success"; logs: TxLog[] }> {
  // Inside a host, signing and submitting go through the host channel: with it down, a transaction
  // would wait at the signature step with nothing to answer it.
  if (useHostConnectionStore.getState().connection !== "ok") {
    throw new UserFacingError("The connection to the host is lost. Try again once it is back.");
  }
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

  // EVM path: MetaMask eth_sendTransaction + receipt polling. A dry run first gives the same checks as
  // the Substrate path: eth_estimateGas reports an order too large for one transaction as a revert with
  // no reason, which only the dry run's weight tells apart. It needs the value in native planck, so a
  // call that sends value (cross-chain orders, not live yet) skips it.
  if (!options?.value) {
    await dryRunCall(simulationOrigin(from), contractAddress, 0n, fromHex(callData), abi as Abi);
  }
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
  const logs = (receipt.logs ?? []).map((l) => ({
    address: l.address as `0x${string}`,
    topics: l.topics as `0x${string}`[],
    data: l.data as `0x${string}`,
  }));
  return { txHash, status: "success", logs };
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
