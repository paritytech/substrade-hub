import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { readContract, writeContract } from "../lib/contract";
import { faucetAbi } from "../abi/faucet";
import { activeChain } from "../config/chains";
import { isNonZeroAddress } from "../lib/markets";
import { useWalletStore } from "../stores/wallet";
import { useToastStore } from "../stores/toast";
import { POLL_INTERVAL_MS } from "../config/constants";

const SYMBOL = activeChain.knownQuote.symbol;

/** True once a real Faucet address is configured (see chains.ts). */
export function isFaucetConfigured(): boolean {
  return isNonZeroAddress(activeChain.faucetAddress);
}

function formatFaucetError(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  if (/CooldownActive/i.test(msg)) {
    return "You've already claimed — wait for the cooldown to pass before claiming again.";
  }
  if (/FaucetEmpty/i.test(msg)) {
    return `The faucet is out of ${SYMBOL} right now. Try again shortly.`;
  }
  return msg;
}

/** Drip size + seconds left on the caller's cooldown (0 = claimable now). */
export function useFaucetState() {
  const h160 = useWalletStore((s) => s.h160);
  return useQuery({
    queryKey: ["faucet", activeChain.faucetAddress, h160],
    enabled: isFaucetConfigured() && !!h160,
    refetchInterval: POLL_INTERVAL_MS,
    queryFn: async () => {
      const [drip, cooldown, cooldownLeft] = await Promise.all([
        readContract(faucetAbi, "dripAmount", [], activeChain.faucetAddress) as Promise<bigint>,
        readContract(faucetAbi, "cooldown", [], activeChain.faucetAddress) as Promise<bigint>,
        readContract(faucetAbi, "claimableIn", [h160!], activeChain.faucetAddress) as Promise<bigint>,
      ]);
      return { drip, cooldown, cooldownLeft };
    },
  });
}

export function useClaimFaucet() {
  const queryClient = useQueryClient();
  const h160 = useWalletStore((s) => s.h160);
  const { addToast, updateToast } = useToastStore();

  return useMutation({
    mutationFn: async () => {
      if (!h160) throw new Error("Connect a wallet first");
      const toastId = addToast("pending", `Requesting test ${SYMBOL}...`);
      try {
        const res = await writeContract(faucetAbi, "claim", [], activeChain.faucetAddress, h160);
        updateToast(toastId, "success", `Test ${SYMBOL} received!`);
        return res;
      } catch (e) {
        updateToast(toastId, "error", formatFaucetError(e));
        throw e;
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["tokenBalance"] });
      queryClient.invalidateQueries({ queryKey: ["faucet"] });
    },
  });
}
