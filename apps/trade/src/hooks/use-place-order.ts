import { useMutation, useQueryClient } from "@tanstack/react-query";
import { writeContract, readContract, simulateContract } from "../lib/contract";
import { dlobAbi } from "../abi/dlob";
import { erc20Abi } from "../abi/erc20";
import { useWalletStore } from "../stores/wallet";
import { useMarketStore } from "../stores/market";
import { useToastStore } from "../stores/toast";
import { quoteAmountCeil, marketApproveAmount } from "../lib/format";
import { parseTokenAmount } from "../lib/format";
import { Side } from "../types/market";
import { activeChain } from "../config/chains";

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

          // Sells escrow exactly `amount`; buys read the quote balance (fill-dependent). See
          // marketApproveAmount for the exact-escrow rationale.
          const quoteBalance =
            params.side === Side.Buy
              ? ((await readContract(erc20Abi, "balanceOf", [h160], escrowToken)) as bigint)
              : 0n;
          const approveAmount = marketApproveAmount(params.side, amount, quoteBalance);

          const currentAllowance = (await readContract(
            erc20Abi,
            "allowance",
            [h160, market.address],
            escrowToken,
          )) as bigint;

          if (currentAllowance < approveAmount) {
            updateToast(toastId, "pending", "Approving token spend...");
            await writeContract(
              erc20Abi,
              "approve",
              [market.address, approveAmount],
              escrowToken,
              h160,
            );
          }

          const marketArgs = [
            params.side,
            amount,
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
            throw new Error(
              `No ${params.side === Side.Buy ? "sell-side" : "buy-side"} liquidity to fill this market order right now. Place a limit order instead.`,
            );
          }

          updateToast(toastId, "pending", `Placing market ${sideLabel.toLowerCase()} order...`);
          const result = await writeContract(
            dlobAbi,
            "placeMarketOrder",
            marketArgs,
            market.address,
            h160,
            { value },
          );
          updateToast(toastId, "success", `Market ${sideLabel.toLowerCase()} order filled!`);
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

/** Map raw contract errors to user-friendly messages */
function formatOrderError(err: unknown): string {
  let msg: string;
  if (err instanceof Error) {
    msg = err.message;
  } else if (typeof err === "string") {
    msg = err;
  } else {
    try {
      msg = JSON.stringify(err);
    } catch {
      msg = String(err);
    }
  }
  console.log("[formatOrderError] raw:", msg);

  // Known DLOB revert reasons (match both name and selector)
  if (msg.includes("SelfTrade") || msg.includes("0xd68a1e65"))
    return "Cannot trade against your own order — use a different account than the one that placed the resting orders";
  if (msg.includes("BelowMinSize")) return "Order amount is below the minimum size";
  if (msg.includes("AboveMaxSize")) return "Order amount exceeds the maximum size";
  if (msg.includes("PriceNotAligned")) return "Price must be a multiple of the tick size";
  if (msg.includes("SlippageExceeded")) return "Price moved too far — try again";
  if (msg.includes("InsufficientBalance") || msg.includes("BalanceLow"))
    return "Insufficient token balance";
  if (msg.includes("InsufficientAllowance") || msg.includes("allowance"))
    return "Token approval failed — please try again";
  if (msg.includes("User rejected") || msg.includes("user rejected"))
    return "Transaction rejected by wallet";
  // Map known DLOB error selectors to user-friendly messages.
  // The RPC returns selectors as raw bytes garbled into UTF-8 (e.g. "֊\x1ee" for 0xd68a1e65).
  // Convert each known selector to its garbled string for matching.
  const knownSelectors: Array<[string, string]> = [
    ["d68a1e65", "Cannot trade against your own order — use a different account"],
    ["4ae094cb", "Order amount is below the minimum size"],
    ["d3c5077b", "Order amount exceeds the maximum size"],
    ["4851d385", "Price must be a multiple of the tick size"],
    ["8199f5f3", "Price moved too far — try again (slippage exceeded)"],
    ["2c5211c6", "Invalid order amount"],
    ["00bfc921", "Invalid price"],
    ["ab143c06", "Reentrancy detected — please try again"],
  ];
  for (const [sel, reason] of knownSelectors) {
    // Match hex form (e.g. "0xd68a1e65" in a data field)
    if (msg.includes("0x" + sel) || msg.includes("0x" + sel.toUpperCase())) return reason;
    // Match garbled UTF-8 form: decode selector bytes as a string
    try {
      const bytes = new Uint8Array(sel.match(/.{2}/g)!.map((b) => parseInt(b, 16)));
      const garbled = new TextDecoder().decode(bytes);
      if (msg.includes(garbled)) return reason;
    } catch { /* skip */ }
  }

  if (msg.includes("execution reverted"))
    return "Transaction reverted by the contract — check your order parameters";
  if (msg.includes("Priority is too low") || msg.includes("Invalid Transaction"))
    return "Transaction rejected — a previous transaction is still pending. Wait a moment and try again";

  // Strip hex data noise for unknown errors
  const clean = msg.replace(/0x[0-9a-fA-F]{8,}/g, "").replace(/\s+/g, " ").trim();
  return clean.length > 120 ? clean.slice(0, 120) + "..." : clean || "Transaction failed";
}
