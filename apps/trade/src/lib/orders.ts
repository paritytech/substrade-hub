/**
 * Whether an order should appear in "Open Orders": a genuinely resting limit order, Active, not fully
 * filled, and owned by the account.
 *
 * Two DLOB quirks produce ghost rows that must be excluded:
 *  - A fully-filled order keeps `status == Active` (it's dequeued from the book but the status isn't
 *    flipped), so filter on `remainingAmount > 0`.
 *  - A market order has `price == 0` and never rests on the book, but its order struct lingers (Active,
 *    with any unfilled remainder), so filter on `price > 0` too — only limit orders truly rest.
 */
export function isOpenOrder(
  order: { status: number; price: bigint; remainingAmount: bigint; originAccount: string },
  originAccount: string,
): boolean {
  return (
    order.status === 0 && // OrderStatus.Active
    order.price > 0n && // exclude market-order ghosts (price 0 never rests)
    order.remainingAmount > 0n &&
    order.originAccount.toLowerCase() === originAccount.toLowerCase()
  );
}
