import { WAD } from "../config/constants";
import { Side, type OrderBookLevel } from "../types/market";

/** Default slippage tolerance for market orders, in basis points (1%). */
export const DEFAULT_SLIPPAGE_BPS = 100n;

const BPS = 10_000n;
const MAX_UINT96 = (1n << 96n) - 1n;

export interface MarketOrderEstimate {
  /** Base amount the visible book can fill. Less than the order's amount when the book is too thin. */
  fillable: bigint;
  /** Quote the buyer pays, or the seller receives, for `fillable`. */
  quote: bigint;
  /** Average price of the estimated fill (18-decimal fixed point). */
  averagePrice: bigint;
  /** Worst price the estimated fill reaches: the highest ask for a buy, the lowest bid for a sell. */
  worstPrice: bigint;
  /**
   * Price limit sent with the order: `worstPrice` plus the slippage tolerance for a buy, minus it for
   * a sell. The contract stops matching beyond it, so the book can move by at most the tolerance.
   */
  limitPrice: bigint;
}

/**
 * Estimate a market order of `amount` base against `levels`, the opposite side of the book with the
 * best price first (asks for a buy, bids for a sell). Returns null when the book is empty.
 */
export function estimateMarketOrder(
  side: Side,
  amount: bigint,
  levels: readonly OrderBookLevel[],
  slippageBps: bigint = DEFAULT_SLIPPAGE_BPS,
): MarketOrderEstimate | null {
  let fillable = 0n;
  let quote = 0n;
  let worstPrice = 0n;
  for (const level of levels) {
    if (fillable >= amount) break;
    const fill = amount - fillable < level.totalAmount ? amount - fillable : level.totalAmount;
    if (fill === 0n) continue;
    fillable += fill;
    quote += (fill * level.price) / WAD; // the contract pays each fill rounded down
    worstPrice = level.price;
  }
  if (fillable === 0n) return null;

  const limitPrice =
    side === Side.Buy
      ? min((worstPrice * (BPS + slippageBps)) / BPS, MAX_UINT96)
      : (worstPrice * (BPS - slippageBps) + BPS - 1n) / BPS;
  return { fillable, quote, averagePrice: (quote * WAD) / fillable, worstPrice, limitPrice };
}

function min(a: bigint, b: bigint): bigint {
  return a < b ? a : b;
}
