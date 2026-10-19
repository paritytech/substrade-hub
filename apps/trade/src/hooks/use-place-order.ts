import { useMutation, useQueryClient } from "@tanstack/react-query";
import { writeContract, readContract, simulateContract } from "../lib/contract";
import { dlobAbi } from "../abi/dlob";
import { erc20Abi } from "../abi/erc20";
import { useWalletStore } from "../stores/wallet";
import { useMarketStore } from "../stores/market";
import { txProgressToast, useToastStore } from "../stores/toast";
import { quoteAmountCeil, marketApproveAmount } from "../lib/format";
import { parseTokenAmount } from "../lib/format";
import { Side } from "../types/market";
import { activeChain } from "../config/chains";
import { MAX_OB_LEVELS } from "../config/constants";
import { estimateMarketOrder } from "../lib/market-order";
import { fetchOrderBook } from "./use-order-book";
import { isEmptyRevert, messageFor, userMessage, UserFacingError } from "../lib/user-errors";

interface PlaceOrderParams {
  side: Side;
  orderType: "limit" | "market";
  price: string;
  amount: string;
  /** Market orders: the price limit the form displayed, so the order carries what the user saw. */
  limitPrice?: bigint;
}

export function usePlaceOrder() {
  const queryClient = useQueryClient();
  const { h160, originAccount } = useWalletStore();
  const market = useMarketStore((s) => s.selectedMarket);
  const { addToast, updateToast } = useToastStore();

  return useMutation({
    mutationFn: async (params: PlaceOrderParams) => {
      if (!h160 || !originAccount || !market)
        throw new UserFacingError("Connect a wallet and select a market first");

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
            updateToast(toastId, "pending", "Approving token spend: waiting for signature...");
            await writeContract(
              erc20Abi,
              "approve",
              [market.address, escrowAmount],
              escrowToken,
              h160,
              { onProgress: txProgressToast(toastId, { pending: "Approving token spend" }) },
            );
          }

          const placing = `Placing ${sideLabel.toLowerCase()} order`;
          updateToast(toastId, "pending", `${placing}: waiting for signature...`);
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
            { value, onProgress: txProgressToast(toastId, { pending: placing, done: `${sideLabel} order placed` }) },
          );
          return result;
        } else {
          const escrowToken =
            params.side === Side.Buy ? market.quote.addr : market.base.addr;

          // The order carries the limit the form displayed; it also bounds what a buy can spend. The
          // fresh book only confirms there is something to fill (and prices orders sent without a form).
          const opposite = params.side === Side.Buy ? Side.Sell : Side.Buy;
          const estimate = estimateMarketOrder(
            params.side,
            amount,
            await fetchOrderBook(market.address, opposite, MAX_OB_LEVELS),
          );
          if (!estimate) {
            throw new UserFacingError(
              `No ${params.side === Side.Buy ? "sell-side" : "buy-side"} liquidity to fill this market order right now. Place a limit order instead.`,
            );
          }
          const limitPrice = params.limitPrice ?? estimate.limitPrice;
          const approveAmount = marketApproveAmount(params.side, amount, limitPrice);

          const currentAllowance = (await readContract(
            erc20Abi,
            "allowance",
            [h160, market.address],
            escrowToken,
          )) as bigint;

          if (currentAllowance < approveAmount) {
            updateToast(toastId, "pending", "Approving token spend: waiting for signature...");
            await writeContract(
              erc20Abi,
              "approve",
              [market.address, approveAmount],
              escrowToken,
              h160,
              { onProgress: txProgressToast(toastId, { pending: "Approving token spend" }) },
            );
          }

          const marketArgs = [
            params.side,
            amount,
            limitPrice,
            0n,
            originAccount,
            ZERO_BYTES32,
            destParaId,
          ] as const;

          // Authoritative liquidity check: simulate the order and require a non-zero fill. A market
          // order matches the opposite side; if nothing there is fillable it silently fills 0 (no
          // revert) and still burns gas. `getBestPrices` can't catch this because it returns cached
          // tree prices that still list lazily-expired orders — so an all-expired opposite side would
          // pass. The simulation runs matching for real (skipping expired makers), and runs after the
          // approve so a buy's quote transfer / a sell's base escrow succeed in the sim.
          // Ordering note: it MUST run after approve (a pre-approve sim would revert on the transfer),
          // so in the rare all-expired case an approve is already on-chain when we block here. The
          // common empty-book case never reaches this — the form disables submit pre-approve via
          // getBestPrices — so only that edge spends an approve; the sim still saves the no-op fill gas.
          updateToast(toastId, "pending", "Checking market liquidity...");
          const filled = (await simulateContract(
            dlobAbi,
            "placeMarketOrder",
            marketArgs,
            market.address,
            h160,
            { value },
          )) as bigint;
          if (filled === 0n) {
            throw new UserFacingError(
              `No ${params.side === Side.Buy ? "sell-side" : "buy-side"} liquidity to fill this market order right now. Place a limit order instead.`,
            );
          }

          const placing = `Placing market ${sideLabel.toLowerCase()} order`;
          updateToast(toastId, "pending", `${placing}: waiting for signature...`);
          const result = await writeContract(
            dlobAbi,
            "placeMarketOrder",
            marketArgs,
            market.address,
            h160,
            {
              value,
              onProgress: txProgressToast(toastId, {
                pending: placing,
                done: `Market ${sideLabel.toLowerCase()} order filled`,
              }),
            },
          );
          return result;
        }
      } catch (err) {
        const txHash = (err as Error & { txHash?: string }).txHash;
        const opts = txHash && activeChain.explorerUrl
          ? { link: { label: "View failed tx on Subscan", href: `${activeChain.explorerUrl}/tx/${txHash}` }, sticky: true }
          : undefined;
        updateToast(toastId, "error", formatOrderError(err), opts);
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

const ORDER_ERROR = "Couldn't complete the transaction. Please try again.";
/**
 * A revert with no reason while trading: the token precompile reverts that way when it rejects the
 * escrow transfer, usually for too little balance or approval.
 */
const ORDER_EMPTY_REVERT = "The transaction was rejected — check your token balance and approval, then try again";

/**
 * The text an order toast shows for `err`: a user or contract error as thrown (see lib/user-errors),
 * else a generic message. Logs the error's details to the console.
 */
export function formatOrderError(err: unknown): string {
  const text = userMessage(err, ORDER_ERROR);
  return isEmptyRevert(err) ? ORDER_EMPTY_REVERT : text;
}

/** `formatOrderError` without the console log, for text rendered on every render. */
export function orderErrorText(err: unknown): string {
  return isEmptyRevert(err) ? ORDER_EMPTY_REVERT : messageFor(err, ORDER_ERROR);
}
