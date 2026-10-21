import { ORDER_LIFETIME_S } from "../config/constants";
import { Side } from "../types/market";

/**
 * Whether an order should appear in "Open Orders": a genuinely resting limit order, Active, not fully
 * filled, and owned by the account. Ownership needs both the sender (`owner`, the only party that can
 * cancel) and `originAccount`: the latter is supplied by the caller, so anyone can place an order
 * carrying another account's `originAccount`.
 *
 * Two DLOB quirks produce ghost rows that must be excluded:
 *  - A fully-filled order keeps `status == Active` (it's dequeued from the book but the status isn't
 *    flipped), so filter on `remainingAmount > 0`.
 *  - A market order has `price == 0` and never rests on the book, but its order struct lingers (Active,
 *    with any unfilled remainder), so filter on `price > 0` too — only limit orders truly rest.
 */
export function isOpenOrder(
  order: { owner: string; status: number; price: bigint; remainingAmount: bigint; originAccount: string },
  account: { h160: string; originAccount: string },
): boolean {
  return (
    order.status === 0 && // OrderStatus.Active
    order.price > 0n && // exclude market-order ghosts (price 0 never rests)
    order.remainingAmount > 0n &&
    order.owner.toLowerCase() === account.h160.toLowerCase() &&
    order.originAccount.toLowerCase() === account.originAccount.toLowerCase()
  );
}

/**
 * Whether a post-only limit order at `price` would be rejected: its price reaches the best price on
 * the other side (a buy at or above the best ask, a sell at or below the best bid), as the contract
 * checks it. A best price of 0 means that side is empty.
 */
export function postOnlyCrosses(side: Side, price: bigint, best: { bestBid: bigint; bestAsk: bigint }): boolean {
  if (side === Side.Buy) return best.bestAsk !== 0n && price >= best.bestAsk;
  return best.bestBid !== 0n && price <= best.bestBid;
}

/** The `expireTimestamp` (unix seconds) of a limit order sent at `nowMs`: `ORDER_LIFETIME_S` later. */
export function orderExpiry(nowMs: number = Date.now()): bigint {
  return BigInt(Math.floor(nowMs / 1000) + ORDER_LIFETIME_S);
}

/** Whether an order has expired at `nowMs`: the contract treats it as expired from `expireTimestamp` on. */
export function isExpired(expireTimestamp: bigint, nowMs: number = Date.now()): boolean {
  return expireTimestamp !== 0n && Number(expireTimestamp) <= Math.floor(nowMs / 1000);
}

/**
 * When an order expires, for Open Orders: "Never" (`expireTimestamp` 0), "Expired" once it has, else
 * the time left in hours and minutes.
 */
export function expiryLabel(expireTimestamp: bigint, nowMs: number = Date.now()): string {
  if (expireTimestamp === 0n) return "Never";
  if (isExpired(expireTimestamp, nowMs)) return "Expired";
  const left = Number(expireTimestamp) - Math.floor(nowMs / 1000);
  if (left >= 3600) return `in ${Math.floor(left / 3600)}h ${Math.floor((left % 3600) / 60)}m`;
  return `in ${Math.max(1, Math.floor(left / 60))}m`;
}
