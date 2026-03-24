import { useMutation, useQueryClient } from "@tanstack/react-query";
import { writeContract } from "../lib/contract";
import { dlobAbi } from "../abi/dlob";
import { useWalletStore } from "../stores/wallet";
import { useMarketStore } from "../stores/market";

export function useCancelOrder() {
  const queryClient = useQueryClient();
  const { h160, originAccount } = useWalletStore();
  const market = useMarketStore((s) => s.selectedMarket);

  return useMutation({
    mutationFn: async (orderId: number) => {
      if (!h160 || !originAccount || !market)
        throw new Error("Wallet not connected or no market selected");

      return writeContract(
        dlobAbi,
        "cancelOrder",
        [orderId, originAccount],
        market.address,
        h160,
      );
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["orderBook"] });
      queryClient.invalidateQueries({ queryKey: ["userOrders"] });
      queryClient.invalidateQueries({ queryKey: ["bestPrices"] });
      queryClient.invalidateQueries({ queryKey: ["tokenBalance"] });
    },
  });
}
