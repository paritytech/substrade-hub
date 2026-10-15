import { WAD } from "../config/constants";
import { Side, type OrderBookLevel } from "../types/market";

/** Default slippage tolerance for market orders, in basis points (1%). */
export const DEFAULT_SLIPPAGE_BPS = 100n;

/**
 * Furthest a market order may reach from the best price, in basis points (10%). Levels beyond it are
 * not filled, so an order resting at an extreme price cannot fill a market order wherever it sits in
 * the book.
 */
export const MAX_PRICE_IMPACT_BPS = 1_000n;

const BPS = 10_000n;
const MAX_UINT96 = (1n << 96n) - 1n;

export interface MarketOrderEstimate {
  /**
   * Base amount that can fill within `MAX_PRICE_IMPACT_BPS` of the best price. Less than the order's
   * amount when the book is too thin there.
   */
  fillable: bigint;
  /** Quote the buyer pays, or the seller receives, for `fillable`. */
  quote: bigint;
  /** Average price of the estimated fill (18-decimal fixed point). */
  averagePrice: bigint;
  /** Worst price the estimated fill reaches: the highest ask for a buy, the lowest bid for a sell. */
  worstPrice: bigint;
  /**
   * Price limit sent with the order: `worstPrice` plus the slippage tolerance for a buy (minus it for
   * a sell), and never beyond `MAX_PRICE_IMPACT_BPS` from the best price. The contract stops matching
   * there.
   */
  limitPrice: bigint;
}

/**
 * Estimate a market order of `amount` base against `levels`, the opposite side of the book with the
 * best price first (asks for a buy, bids for a sell). Only levels within `MAX_PRICE_IMPACT_BPS` of
 * the best price count. Returns null when the book is empty.
 */
export function estimateMarketOrder(
  side: Side,
  amount: bigint,
  levels: readonly OrderBookLevel[],
  slippageBps: bigint = DEFAULT_SLIPPAGE_BPS,
): MarketOrderEstimate | null {
  const best = levels.find((l) => l.totalAmount > 0n)?.price;
  if (best === undefined) return null;
  const isBuy = side === Side.Buy;
  // The furthest price the order may reach: above the best ask for a buy, below the best bid for a sell.
  const cap = isBuy
    ? min((best * (BPS + MAX_PRICE_IMPACT_BPS)) / BPS, MAX_UINT96)
    : (best * (BPS - MAX_PRICE_IMPACT_BPS) + BPS - 1n) / BPS;

  let fillable = 0n;
  let quote = 0n;
  let worstPrice = 0n;
  for (const level of levels) {
    if (fillable >= amount || (isBuy ? level.price > cap : level.price < cap)) break;
    const fill = amount - fillable < level.totalAmount ? amount - fillable : level.totalAmount;
    if (fill === 0n) continue;
    fillable += fill;
    quote += (fill * level.price) / WAD; // the contract pays each fill rounded down
    worstPrice = level.price;
  }
  if (fillable === 0n) return null;

  const limitPrice = isBuy
    ? min((worstPrice * (BPS + slippageBps)) / BPS, cap)
    : max((worstPrice * (BPS - slippageBps) + BPS - 1n) / BPS, cap);
  return { fillable, quote, averagePrice: (quote * WAD) / fillable, worstPrice, limitPrice };
}

function min(a: bigint, b: bigint): bigint {
  return a < b ? a : b;
}

function max(a: bigint, b: bigint): bigint {
  return a > b ? a : b;
}
