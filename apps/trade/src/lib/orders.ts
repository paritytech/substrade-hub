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
