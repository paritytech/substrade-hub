import { useMutation, useQueryClient } from "@tanstack/react-query";
import { decodeFunctionResult, formatUnits, size, type ContractFunctionArgs } from "viem";
import { writeContract, readContract, simulateContract, simulateContractData } from "../lib/contract";
import { dlobAbi } from "../abi/dlob";
import { erc20Abi } from "../abi/erc20";
import { useWalletStore } from "../stores/wallet";
import { useMarketStore } from "../stores/market";
import { confirmToast, txProgressToast, useToastStore } from "../stores/toast";
import { quoteAmountCeil, marketApproveAmount } from "../lib/format";
import type { TxStep } from "../lib/tx-progress";
import { parseTokenAmount } from "../lib/format";
import { Side, type OrderBookLevel } from "../types/market";
import { activeChain } from "../config/chains";
import { MAX_OB_LEVELS } from "../config/constants";
import { estimateMarketOrder } from "../lib/market-order";
import { fetchOrderBook } from "./use-order-book";
import { isEmptyRevert, messageFor, userMessage, UserFacingError } from "../lib/user-errors";
import { MAX_PARTS, PartFailedError, placeInParts, TooManyPartsError, type PartOutcome, type PartsResult } from "../lib/split-order";

interface PlaceOrderParams {
  side: Side;
  orderType: "limit" | "market";
  price: string;
  amount: string;
  /** Market orders: the price limit the form displayed, so the order carries what the user saw. */
  limitPrice?: bigint;
}

/** What placing an order came to: `placed` is false when the user declined before anything was sent. */
export interface PlaceOrderResult {
  placed: boolean;
}

export function usePlaceOrder() {
  const queryClient = useQueryClient();
  const { h160, originAccount } = useWalletStore();
  const market = useMarketStore((s) => s.selectedMarket);
  const { addToast, updateToast, removeToast } = useToastStore();

  return useMutation({
    mutationFn: async (params: PlaceOrderParams): Promise<PlaceOrderResult> => {
      if (!h160 || !originAccount || !market)
        throw new UserFacingError("Connect a wallet and select a market first");

      const side = params.side === Side.Buy ? "buy" : "sell";
      const isLimit = params.orderType === "limit";
      const toastId = addToast("pending", `Preparing ${side} order...`);
      const base = (amount: bigint) => `${formatUnits(amount, market.base.decimals)} ${market.base.symbol}`;

      try {
        const amount = parseTokenAmount(params.amount, market.base.decimals);
        // For local orders (destParaId=0), settlementAccount must be bytes32(0).
        const ZERO_BYTES32 = "0x0000000000000000000000000000000000000000000000000000000000000000" as `0x${string}`;
        const escrowToken = params.side === Side.Buy ? market.quote.addr : market.base.addr;

        /** Approve the market for `needed` of the escrowed token when the allowance is short. */
        const ensureAllowance = async (needed: bigint) => {
          const allowance = (await readContract(erc20Abi, "allowance", [h160, market.address], escrowToken)) as bigint;
          if (allowance >= needed) return;
          updateToast(toastId, "pending", "Approving token spend: waiting for signature...");
          await writeContract(erc20Abi, "approve", [market.address, needed], escrowToken, h160, {
            onProgress: txProgressToast(toastId, { pending: "Approving token spend" }),
          });
        };

        // The pending text of the transaction being signed, for its progress steps.
        let label = "";
        const progress = (step: TxStep) => txProgressToast(toastId, { pending: label })(step);

        let simulate: (remaining: bigint) => Promise<PartOutcome>;
        let send: (size: bigint) => Promise<unknown>;
        let placing: string;

        if (isLimit) {
          const price = parseTokenAmount(params.price);
          const escrow = (size: bigint) => (params.side === Side.Buy ? quoteAmountCeil(size, price) : size);
          const args = (size: bigint) => [params.side, price, size, originAccount, ZERO_BYTES32, 0, 0n] as const;
          placing = `placing ${side} order`;
          // One transaction fills only so many resting orders: when this order crosses more, the
          // contract returns what is left (resting it would cross the book), and the simulation says how
          // much. What fits below the minimum order size means expired or small orders at the front of
          // the book, which sending the order clears.
          simulate = async (remaining) => {
            await ensureAllowance(escrow(remaining));
            updateToast(toastId, "pending", "Checking the order book...");
            const returned = await limitOrderReturned(args(remaining), market.address, h160);
            if (returned === 0n) return { kind: "whole" };
            if (remaining - returned < market.minOrderSize) return { kind: "clears" };
            return { kind: "part", fills: remaining - returned };
          };
          send = async (size) => {
            await ensureAllowance(escrow(size));
            return writeContract(dlobAbi, "placeLimitOrder", args(size), market.address, h160, {
              onProgress: progress,
            });
          };
        } else {
          // The order carries the limit the form displayed; it also bounds what a buy can spend. The
          // fresh book only confirms there is something to fill (and prices orders sent without a form).
          const opposite = params.side === Side.Buy ? Side.Sell : Side.Buy;
          const estimate = estimateMarketOrder(
            params.side,
            amount,
            await fetchOrderBook(market.address, opposite, MAX_OB_LEVELS),
          );
          if (!estimate) throw new UserFacingError(noLiquidity(params.side));
          const limitPrice = params.limitPrice ?? estimate.limitPrice;
          const args = (size: bigint) => [params.side, size, limitPrice, 0n, originAccount, ZERO_BYTES32, 0] as const;
          placing = `placing market ${side} order`;
          // The simulation runs matching for real: `getBestPrices` cannot tell what fills, since the tree
          // still lists lazily-expired orders. It runs after the approve, which the escrow transfer needs.
          // A fill short of the order is the match budget when the book lists more within the limit,
          // else all the book has; nothing filling while the book lists orders within the limit means
          // expired orders at the front, which sending the order clears.
          simulate = async (remaining) => {
            await ensureAllowance(marketApproveAmount(params.side, remaining, limitPrice));
            updateToast(toastId, "pending", "Checking market liquidity...");
            const [filled, book] = await Promise.all([
              simulateContract(dlobAbi, "placeMarketOrder", args(remaining), market.address, h160) as Promise<bigint>,
              fetchOrderBook(market.address, opposite, MAX_OB_LEVELS),
            ]);
            if (filled === remaining) return { kind: "whole" };
            if (filled === 0n) return withinLimit(params.side, book[0]?.price, limitPrice) ? { kind: "clears" } : { kind: "none" };
            if (liquidityWithin(params.side, book, limitPrice) <= filled) return { kind: "whole" };
            if (filled < market.minOrderSize) return { kind: "clears" };
            return { kind: "part", fills: filled };
          };
          send = (size) =>
            writeContract(dlobAbi, "placeMarketOrder", args(size), market.address, h160, { onProgress: progress });
        }

        let result: PartsResult;
        try {
          result = await placeInParts({
            amount,
            minOrderSize: market.minOrderSize,
            simulate,
            confirm: (parts) =>
              confirmToast(
                toastId,
                `This order crosses more resting orders than one transaction can fill. It needs about ${parts} transactions, with a signature each.`,
                `Place in ${parts} transactions`,
              ),
            send: async (size, part, of, outcome) => {
              const what = outcome === "clears" ? CLEARING_FRONT : placing;
              label = of > 1 ? `Part ${part} of about ${of}: ${what}` : capitalize(what);
              updateToast(toastId, "pending", `${label}: waiting for signature...`);
              await send(size);
            },
          });
        } catch (err) {
          if (err instanceof TooManyPartsError) {
            throw new UserFacingError(
              `This order needs more than ${MAX_PARTS} transactions. Place up to ${base(err.perPart * BigInt(MAX_PARTS))} at a time.`,
            );
          }
          if (err instanceof PartFailedError) {
            throw new UserFacingError(
              `${formatOrderError(err.cause)} ${parts(err.sent)} went through; ${base(err.remaining)} was not placed.`,
            );
          }
          throw err;
        }

        const kind = isLimit ? `${capitalize(side)} order` : `Market ${side} order`;
        const done = isLimit ? "placed" : "filled";
        switch (result.status) {
          case "cancelled":
            removeToast(toastId);
            return { placed: false };
          case "dry":
            if (result.sent === 0) throw new UserFacingError(noLiquidity(params.side));
            updateToast(toastId, "success", `${kind} ${done} in ${parts(result.sent)}. No more orders within the price limit, so ${base(result.remaining)} was not filled.`);
            break;
          case "dust":
            updateToast(toastId, "success", `${kind} ${done} in ${parts(result.sent)}. The last ${base(result.remaining)} is below the minimum order size and was not placed.`);
            break;
          case "capped":
            updateToast(toastId, "success", `${kind} ${done} in ${parts(result.sent)}, the most for one order. ${base(result.remaining)} was not placed: place it again.`);
            break;
          case "done":
            if (result.final === "clears") updateToast(toastId, "success", FRONT_CLEARED);
            else updateToast(toastId, "success", result.sent === 1 ? `${kind} ${done}` : `${kind} ${done} in ${parts(result.sent)}`);
            break;
        }
        return { placed: true };
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

/** "1 transaction", "3 transactions". */
function parts(n: number): string {
  return n === 1 ? "1 transaction" : `${n} transactions`;
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function noLiquidity(side: Side): string {
  return `No ${side === Side.Buy ? "sell-side" : "buy-side"} liquidity to fill this market order right now. Place a limit order instead.`;
}

/** Base amount the opposite side `levels` lists within a market order's `limitPrice`. */
export function liquidityWithin(side: Side, levels: readonly OrderBookLevel[], limitPrice: bigint): bigint {
  let total = 0n;
  for (const level of levels) {
    if (!withinLimit(side, level.price, limitPrice)) break;
    total += level.totalAmount;
  }
  return total;
}

/** The pending text of an order that can only clear the front of the book. */
const CLEARING_FRONT = "clearing expired or small orders at the front of the book";

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
