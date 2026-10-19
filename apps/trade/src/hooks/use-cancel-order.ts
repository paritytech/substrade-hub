import { useMutation, useQueryClient } from "@tanstack/react-query";
import { writeContract } from "../lib/contract";
import { dlobAbi } from "../abi/dlob";
import { useWalletStore } from "../stores/wallet";
import { useMarketStore } from "../stores/market";
import { txProgressToast, useToastStore } from "../stores/toast";
import { userMessage, UserFacingError } from "../lib/user-errors";

export function useCancelOrder() {
  const queryClient = useQueryClient();
  const { h160, originAccount } = useWalletStore();
  const market = useMarketStore((s) => s.selectedMarket);
  const { addToast, updateToast } = useToastStore();

  return useMutation({
    mutationFn: async (orderId: number) => {
      if (!h160 || !originAccount || !market)
        throw new UserFacingError("Connect a wallet and select a market first");

      const cancelling = `Cancelling order #${orderId}`;
      const toastId = addToast("pending", `${cancelling}: waiting for signature...`);
      try {
        return await writeContract(
          dlobAbi,
          "cancelOrder",
          [orderId, originAccount],
          market.address,
          h160,
          { onProgress: txProgressToast(toastId, { pending: cancelling, done: `Order #${orderId} cancelled` }) },
        );
      } catch (err) {
        updateToast(toastId, "error", userMessage(err, "Couldn't cancel the order. Please try again."));
        throw err;
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["orderBook"] });
      queryClient.invalidateQueries({ queryKey: ["userOrders"] });
      queryClient.invalidateQueries({ queryKey: ["bestPrices"] });
      queryClient.invalidateQueries({ queryKey: ["tokenBalance"] });
    },
  });
}
