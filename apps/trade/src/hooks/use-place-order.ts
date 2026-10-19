import { useMutation, useQueryClient } from "@tanstack/react-query";
import { decodeFunctionResult, formatUnits, size, type ContractFunctionArgs } from "viem";
import { writeContract, readContract, simulateContract, simulateContractData } from "../lib/contract";
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

          const limitArgs = [params.side, price, amount, originAccount, ZERO_BYTES32, destParaId, 0n] as const;
          // One transaction fills only so many resting orders. When this order crosses more, the contract
          // returns what is left (resting it would cross the book), so ask for a smaller order up front,
          // unless what fits is too small to place: then the front of the book is expired or small
          // orders, and sending the order is what clears them.
          updateToast(toastId, "pending", "Checking the order book...");
          const returned = await limitOrderReturned(limitArgs, market.address, h160);
          const clearsFront = returned > 0n && amount - returned < market.minOrderSize;
          if (returned > 0n && !clearsFront) {
            throw new UserFacingError(
              `This order crosses more resting orders than one transaction can fill. Place ${formatUnits(amount - returned, baseDecimals)} ${market.base.symbol} now and the rest in another order.`,
            );
          }

          const placing = clearsFront ? CLEARING_FRONT : `Placing ${sideLabel.toLowerCase()} order`;
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
            limitArgs,
            market.address,
            h160,
            {
              value,
              onProgress: txProgressToast(toastId, {
                pending: placing,
                done: clearsFront ? FRONT_CLEARED : `${sideLabel} order placed`,
              }),
            },
          );
          return result;
        } else {
          const escrowToken =
            params.side === Side.Buy ? market.quote.addr : market.base.addr;

          // The order carries the limit the form displayed; it also bounds what a buy can spend. The
          // fresh book only confirms there is something to fill (and prices orders sent without a form).
          const opposite = params.side === Side.Buy ? Side.Sell : Side.Buy;
          const book = await fetchOrderBook(market.address, opposite, MAX_OB_LEVELS);
          const estimate = estimateMarketOrder(params.side, amount, book);
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

          // Authoritative liquidity check: simulate the order. A market order with nothing fillable fills
          // 0 without reverting and still costs a fee. `getBestPrices` cannot tell, since the tree still
          // lists lazily-expired orders; the simulation runs matching for real. It runs after the approve,
          // which the escrow transfer needs, so a blocked order may already have spent an approve.
          updateToast(toastId, "pending", "Checking market liquidity...");
          const filled = (await simulateContract(
            dlobAbi,
            "placeMarketOrder",
            marketArgs,
            market.address,
            h160,
            { value },
          )) as bigint;
          // Nothing fills although the book lists orders within the limit: expired orders at the front
          // use up what one transaction may match. Sending the order is what clears them.
          const clearsFront = filled === 0n && withinLimit(params.side, book[0]?.price, limitPrice);
          if (filled === 0n && !clearsFront) {
            throw new UserFacingError(
              `No ${params.side === Side.Buy ? "sell-side" : "buy-side"} liquidity to fill this market order right now. Place a limit order instead.`,
            );
          }

          const placing = clearsFront ? CLEARING_FRONT : `Placing market ${sideLabel.toLowerCase()} order`;
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
                done: clearsFront ? FRONT_CLEARED : `Market ${sideLabel.toLowerCase()} order filled`,
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

/** The pending text of an order that can only clear the front of the book. */
const CLEARING_FRONT = "Clearing expired or small orders at the front of the book";

/** The success text of an order that only cleared the front of the book. */
const FRONT_CLEARED =
  "The order cleared expired or small orders at the front of the book, and the rest came back. Place it again to fill it.";

/** Whether a resting order at `price` on the opposite side is within a market order's `limitPrice`. */
export function withinLimit(side: Side, price: bigint | undefined, limitPrice: bigint): boolean {
  if (price === undefined) return false;
  return side === Side.Buy ? price <= limitPrice : price >= limitPrice;
}

/**
 * What `placeLimitOrder` would hand back unfilled, from a simulation as `from`: the base amount the
 * match budget leaves over when the order still crosses, else 0. Markets whose `placeLimitOrder`
 * returns only the order id rest any remainder, so nothing comes back there.
 */
export async function limitOrderReturned(
  args: ContractFunctionArgs<typeof dlobAbi, "payable", "placeLimitOrder">,
  marketAddress: `0x${string}`,
  from: `0x${string}`,
): Promise<bigint> {
  const data = await simulateContractData(dlobAbi, "placeLimitOrder", args, marketAddress, from);
  if (size(data) < 64) return 0n;
  const [, returned] = decodeFunctionResult({ abi: dlobAbi, functionName: "placeLimitOrder", data });
  return returned;
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
