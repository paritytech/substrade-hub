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

  return accounts[0] as `0x${string}`;
}

export async function sendTransaction(params: {
  to: `0x${string}`;
  data: `0x${string}`;
  from: `0x${string}`;
  value?: bigint;
}): Promise<`0x${string}`> {
  if (!window.ethereum) throw new Error("MetaMask not found");

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

export async function waitForReceipt(txHash: `0x${string}`): Promise<{ status: string }> {
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
