import { activeChain } from "../config/chains";

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

export async function connectMetaMask(): Promise<`0x${string}`> {
  if (!window.ethereum) throw new Error("MetaMask not found");

  // Request account access
  const accounts = (await window.ethereum.request({
    method: "eth_requestAccounts",
  })) as string[];

  if (!accounts.length) throw new Error("No accounts returned");

  // Switch to the correct chain
  try {
    await window.ethereum.request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: `0x${activeChain.chainId.toString(16)}` }],
    });
  } catch (switchError: unknown) {
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
  if (!window.ethereum) throw new Error("MetaMask not found");
  const head = parseInt((await ethRpcDirect("eth_blockNumber")) as string, 16);
  const probe = `0x${Math.max(head - FINGERPRINT_DEPTH, 0).toString(16)}`;
  const [ours, theirs] = (await Promise.all([
    ethRpcDirect("eth_getBlockByNumber", [probe, false]),
    window.ethereum.request({ method: "eth_getBlockByNumber", params: [probe, false] }),
  ])) as [{ hash?: string } | null, { hash?: string } | null];
  if (!ours?.hash || ours.hash !== theirs?.hash) {
    throw new Error(
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
  if (!window.ethereum) throw new Error("MetaMask not found");
  // The wallet's network can change between connect and send.
  await assertWalletOnActiveChain();

  // Estimate gas via our RPC — MetaMask can't estimate on Paseo
  console.log(`[sendTransaction] from=${params.from} to=${params.to} data=${params.data}`);

  const gasEstimate = (await ethRpcDirect("eth_estimateGas", [
    {
      from: params.from,
      to: params.to,
      data: params.data,
    },
  ])) as string;
  const gas = `0x${(parseInt(gasEstimate, 16) * 2).toString(16)}`;
  const gasPrice = (await ethRpcDirect("eth_gasPrice")) as string;

  const txHash = (await window.ethereum.request({
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
  const json = (await res.json()) as { result?: unknown; error?: { message: string } };
  if (json.error) throw new Error(`RPC error: ${json.error.message}`);
  return json.result;
}

export async function waitForReceipt(
  txHash: `0x${string}`,
): Promise<{ status: string; blockNumber: string }> {
  console.log(`[waitForReceipt] polling for ${txHash}...`);
  for (let i = 0; i < 40; i++) {
    try {
      const receipt = (await ethRpcDirect("eth_getTransactionReceipt", [
        txHash,
      ])) as { status: string; gasUsed: string; blockNumber: string } | null;

      if (receipt) {
        console.log(`[waitForReceipt] ${txHash} status: ${receipt.status}, block: ${receipt.blockNumber}`);
        if (receipt.status !== "0x1") {
          const err = new Error("Transaction reverted on chain");
          (err as Error & { txHash: string }).txHash = txHash;
          throw err;
        }
        return receipt;
      }
    } catch (e) {
      if (e instanceof Error && e.message.includes("reverted")) throw e;
      console.log(`[waitForReceipt] poll ${i} error:`, e);
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error("Transaction receipt timeout — check explorer: " + txHash);
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
