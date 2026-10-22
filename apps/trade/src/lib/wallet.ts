// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: © 2026 Parity Technologies
import { activeChain } from "../config/chains";
import { revertError } from "./errors";
import { UserFacingError } from "./user-errors";

declare global {
  interface Window {
    ethereum?: {
      isMetaMask?: boolean;
      request: (args: { method: string; params?: unknown[] }) => Promise<unknown>;
      on: (event: string, handler: (...args: unknown[]) => void) => void;
      removeListener: (event: string, handler: (...args: unknown[]) => void) => void;
    };
  }
}

export function isMetaMaskAvailable(): boolean {
  return typeof window !== "undefined" && !!window.ethereum?.isMetaMask;
}

/** EIP-1193: the user rejected the request in the wallet. */
const isUserRejection = (e: unknown) => (e as { code?: unknown })?.code === 4001;

export async function connectMetaMask(): Promise<`0x${string}`> {
  if (!window.ethereum) throw new UserFacingError("MetaMask isn't installed — install it, or use another wallet");

  // Request account access
  const accounts = (await window.ethereum
    .request({ method: "eth_requestAccounts" })
    .catch((e: unknown) => {
      if (isUserRejection(e)) throw new UserFacingError("The connection was rejected in MetaMask", { cause: e });
      throw e;
    })) as string[];

  if (!accounts.length) throw new UserFacingError("MetaMask has no account to connect — create or unlock one, then retry");

  // Switch to the correct chain
  try {
    await window.ethereum.request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: `0x${activeChain.chainId.toString(16)}` }],
    });
  } catch (switchError: unknown) {
    if (isUserRejection(switchError)) {
      throw new UserFacingError(`Switch MetaMask to ${activeChain.name} to continue`, { cause: switchError });
    }
    // Chain not added — add it
    if ((switchError as { code?: number })?.code === 4902) {
      await window.ethereum.request({
        method: "wallet_addEthereumChain",
        params: [
          {
            chainId: `0x${activeChain.chainId.toString(16)}`,
            chainName: activeChain.name,
            rpcUrls: [activeChain.rpcUrl],
            nativeCurrency: { name: "PAS", symbol: "PAS", decimals: 18 },
          },
        ],
      }).catch((e: unknown) => {
        if (isUserRejection(e)) {
          throw new UserFacingError(`Switch MetaMask to ${activeChain.name} to continue`, { cause: e });
        }
        throw e;
      });
    } else {
      throw switchError;
    }
  }

  await assertWalletOnActiveChain();
  return accounts[0] as `0x${string}`;
}

/** How far behind our head the fingerprint block sits, so a wallet RPC that lags slightly still has it. */
const FINGERPRINT_DEPTH = 5;

/**
 * Check that MetaMask's RPC serves the same chain as ours. Our networks share chain id 420420417, so a
 * MetaMask that already knows that id from another network would switch "successfully" and then send
 * our transactions to the wrong chain. A recent block hash is the fingerprint: a different chain does
 * not have the same block at that height (old blocks are no use, these nodes prune their state).
 */
export async function assertWalletOnActiveChain(): Promise<void> {
  if (!window.ethereum) throw new UserFacingError("MetaMask isn't installed — install it, or use another wallet");
  const head = parseInt((await ethRpcDirect("eth_blockNumber")) as string, 16);
  const probe = `0x${Math.max(head - FINGERPRINT_DEPTH, 0).toString(16)}`;
  const [ours, theirs] = (await Promise.all([
    ethRpcDirect("eth_getBlockByNumber", [probe, false]),
    window.ethereum.request({ method: "eth_getBlockByNumber", params: [probe, false] }),
  ])) as [{ hash?: string } | null, { hash?: string } | null];
  if (!ours?.hash || ours.hash !== theirs?.hash) {
    throw new UserFacingError(
      `MetaMask's network for chain id ${activeChain.chainId} is not ${activeChain.name}. In MetaMask, ` +
        `edit that network's RPC URL to ${activeChain.rpcUrl} and try again.`,
    );
  }
}

export async function sendTransaction(params: {
  to: `0x${string}`;
  data: `0x${string}`;
  from: `0x${string}`;
  value?: bigint;
}): Promise<`0x${string}`> {
  if (!window.ethereum) throw new UserFacingError("MetaMask isn't installed — install it, or use another wallet");
  // The wallet's network can change between connect and send.
  await assertWalletOnActiveChain();

  // Estimate gas via our RPC — MetaMask can't estimate on Paseo
  console.log(`[sendTransaction] from=${params.from} to=${params.to} data=${params.data}`);

  // A call that would revert fails here, with the revert data, before the wallet is asked to sign.
  const gasEstimate = (await ethRpcDirect("eth_estimateGas", [
    {
      from: params.from,
      to: params.to,
      data: params.data,
    },
  ]).catch((e: unknown) => {
    const data = (e as { data?: unknown }).data;
    if (typeof data === "string" && /^0x[0-9a-f]*$/i.test(data)) {
      throw revertError({ value: { data: hexToBytes(data) } });
    }
    throw e;
  })) as string;
  const gas = `0x${(parseInt(gasEstimate, 16) * 2).toString(16)}`;
  const gasPrice = (await ethRpcDirect("eth_gasPrice")) as string;

  const txHash = (await window.ethereum
    .request({
    method: "eth_sendTransaction",
    params: [
      {
        to: params.to,
        from: params.from,
        data: params.data,
        value: params.value ? `0x${params.value.toString(16)}` : undefined,
        gas,
        gasPrice,
      },
    ],
    })
    .catch((e: unknown) => {
      // EIP-1193: 4001 is the user rejecting the request in the wallet.
      if (isUserRejection(e)) throw new UserFacingError("Signing was cancelled.", { cause: e });
      throw e;
    })) as `0x${string}`;

  console.log(`[sendTransaction] txHash: ${txHash}`);
  return txHash;
}

async function ethRpcDirect(method: string, params: unknown[] = []): Promise<unknown> {
  const res = await fetch(activeChain.rpcUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const json = (await res.json()) as { result?: unknown; error?: { message: string; data?: unknown } };
  if (json.error) throw Object.assign(new Error(`RPC error: ${json.error.message}`), { data: json.error.data });
  return json.result;
}

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.slice(2);
  return new Uint8Array(clean.match(/../g)?.map((h) => parseInt(h, 16)) ?? []);
}

export async function waitForReceipt(
  txHash: `0x${string}`,
): Promise<{ status: string; blockNumber: string; logs?: Array<{ address: string; topics: string[]; data: string }> }> {
  console.log(`[waitForReceipt] polling for ${txHash}...`);
  for (let i = 0; i < 40; i++) {
    try {
      const receipt = (await ethRpcDirect("eth_getTransactionReceipt", [
        txHash,
      ])) as {
        status: string;
        gasUsed: string;
        blockNumber: string;
        logs?: Array<{ address: string; topics: string[]; data: string }>;
      } | null;

      if (receipt) {
        console.log(`[waitForReceipt] ${txHash} status: ${receipt.status}, block: ${receipt.blockNumber}`);
        if (receipt.status !== "0x1") {
          const err = new UserFacingError("The transaction was reverted on chain");
          (err as Error & { txHash: string }).txHash = txHash;
          throw err;
        }
        return receipt;
      }
    } catch (e) {
      if (e instanceof UserFacingError) throw e;
      console.log(`[waitForReceipt] poll ${i} error:`, e);
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw Object.assign(
    new UserFacingError("The network didn't confirm the transaction in time — check your orders before trying again", {
      cause: `no receipt for ${txHash}`,
    }),
    { txHash },
  );
}

/** How long to wait for a block to finalize before giving up on reporting it. */
const FINALITY_TIMEOUT_MS = 120_000;

/** Resolve to whether block `blockNumber` (hex) finalized within `FINALITY_TIMEOUT_MS`. */
export async function waitForFinality(blockNumber: string): Promise<boolean> {
  const target = BigInt(blockNumber);
  const deadline = Date.now() + FINALITY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      const head = (await ethRpcDirect("eth_getBlockByNumber", ["finalized", false])) as { number: string } | null;
      if (head && BigInt(head.number) >= target) return true;
    } catch {
      // A failed poll is retried until the deadline.
    }
    await new Promise((r) => setTimeout(r, 3000));
  }
  return false;
}
