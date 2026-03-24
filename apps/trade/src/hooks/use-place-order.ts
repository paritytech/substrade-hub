import { useMutation, useQueryClient } from "@tanstack/react-query";
import { writeContract, readContract } from "../lib/contract";
import { dlobAbi } from "../abi/dlob";
import { erc20Abi } from "../abi/erc20";
import { useWalletStore } from "../stores/wallet";
import { useMarketStore } from "../stores/market";
import { useToastStore } from "../stores/toast";
import { quoteAmountCeil } from "../lib/format";
import { parseTokenAmount } from "../lib/format";
import { Side } from "../types/market";

interface PlaceOrderParams {
  side: Side;
  orderType: "limit" | "market";
  price: string;
  amount: string;
}

export function usePlaceOrder() {
  const queryClient = useQueryClient();
  const { h160, originAccount } = useWalletStore();
  const market = useMarketStore((s) => s.selectedMarket);
  const { addToast, updateToast } = useToastStore();

  return useMutation({
    mutationFn: async (params: PlaceOrderParams) => {
      if (!h160 || !originAccount || !market)
        throw new Error("Wallet not connected or no market selected");

      const sideLabel = params.side === Side.Buy ? "Buy" : "Sell";
      const toastId = addToast("pending", `Preparing ${sideLabel.toLowerCase()} order...`);

      try {
        const baseDecimals = market.base.decimals;
        const amount = parseTokenAmount(params.amount, baseDecimals);
        // For local orders (destParaId=0), settlementAccount must be bytes32(0).
        const ZERO_BYTES32 = "0x0000000000000000000000000000000000000000000000000000000000000000" as `0x${string}`;
        const destParaId = 0;
        const value = 0n;

        if (params.orderType === "limit") {
          const price = parseTokenAmount(params.price);
          const escrowAmount =
            params.side === Side.Buy ? quoteAmountCeil(amount, price) : amount;
          const escrowToken =
            params.side === Side.Buy ? market.quote.addr : market.base.addr;

          const currentAllowance = (await readContract(
            erc20Abi,
            "allowance",
            [h160, market.address],
            escrowToken,
          )) as bigint;

          if (currentAllowance < escrowAmount) {
            updateToast(toastId, "pending", "Approving token spend...");
            await writeContract(
              erc20Abi,
              "approve",
              [market.address, escrowAmount],
              escrowToken,
              h160,
            );
          }

          updateToast(toastId, "pending", `Placing ${sideLabel.toLowerCase()} order...`);
          console.log("[placeLimitOrder] params:", {
            side: params.side,
            price: price.toString(),
            amount: amount.toString(),
            originAccount,
            escrowAmount: escrowAmount.toString(),
            currentAllowance: currentAllowance.toString(),
          });
          const result = await writeContract(
            dlobAbi,
            "placeLimitOrder",
            [
              params.side,
              price,
              amount,
              originAccount,
              ZERO_BYTES32,
              destParaId,
              0n,
            ],
            market.address,
            h160,
            { value },
          );
          updateToast(toastId, "success", `${sideLabel} order placed!`);
          return result;
        } else {
          const escrowToken =
            params.side === Side.Buy ? market.quote.addr : market.base.addr;

          const balance = (await readContract(
            erc20Abi,
            "balanceOf",
            [h160],
            escrowToken,
          )) as bigint;

          const currentAllowance = (await readContract(
            erc20Abi,
            "allowance",
            [h160, market.address],
            escrowToken,
          )) as bigint;

          if (currentAllowance < balance) {
            updateToast(toastId, "pending", "Approving token spend...");
            await writeContract(
              erc20Abi,
              "approve",
              [market.address, balance],
              escrowToken,
              h160,
            );
          }

          updateToast(toastId, "pending", `Placing market ${sideLabel.toLowerCase()} order...`);
          const result = await writeContract(
            dlobAbi,
            "placeMarketOrder",
            [
              params.side,
              amount,
              0n,
              originAccount,
              ZERO_BYTES32,
              destParaId,
            ],
            market.address,
            h160,
            { value },
          );
          updateToast(toastId, "success", `Market ${sideLabel.toLowerCase()} order filled!`);
          return result;
        }
      } catch (err) {
        updateToast(toastId, "error", err instanceof Error ? err.message : "Transaction failed");
        throw err;
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["orderBook"] });
      queryClient.invalidateQueries({ queryKey: ["userOrders"] });
      queryClient.invalidateQueries({ queryKey: ["bestPrices"] });
      queryClient.invalidateQueries({ queryKey: ["tokenBalance"] });
      queryClient.invalidateQueries({ queryKey: ["tokenAllowance"] });
    },
  });
}
