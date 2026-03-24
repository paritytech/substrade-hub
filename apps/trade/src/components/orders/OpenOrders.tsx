import { useUserOrders } from "../../hooks/use-user-orders";
import { useCancelOrder } from "../../hooks/use-cancel-order";
import { useMarketStore } from "../../stores/market";
import { Side } from "../../types/market";
import { formatTokenAmount, tickToDisplayDecimals } from "../../lib/format";
import { Spinner } from "../ui/Spinner";

export function OpenOrders() {
  const market = useMarketStore((s) => s.selectedMarket);
  const priceDecimals = tickToDisplayDecimals(market?.tickSize ?? 10n ** 18n);
  const { data: orders, isLoading } = useUserOrders();
  const cancelOrder = useCancelOrder();

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 border-b border-border px-3 py-2">
        <span className="text-xs font-medium text-text-secondary">
          Open Orders
        </span>
        {isLoading && <Spinner className="h-3 w-3" />}
        {orders && (
          <span className="text-xs text-text-muted">({orders.length})</span>
        )}
      </div>

      <div className="overflow-auto text-xs">
        <table className="w-full">
          <thead>
            <tr className="text-left text-text-muted">
              <th className="px-3 py-1 font-medium">Side</th>
              <th className="px-3 py-1 font-medium">Price</th>
              <th className="px-3 py-1 font-medium">Amount</th>
              <th className="px-3 py-1 font-medium">Filled</th>
              <th className="px-3 py-1 font-medium"></th>
            </tr>
          </thead>
          <tbody>
            {orders?.map((order) => (
              <tr key={order.orderId} className="hover:bg-surface-overlay">
                <td
                  className={`px-3 py-1 ${
                    order.side === Side.Buy ? "text-buy" : "text-sell"
                  }`}
                >
                  {order.side === Side.Buy ? "Buy" : "Sell"}
                </td>
                <td className="px-3 py-1">
                  {formatTokenAmount(order.price, 18, priceDecimals)}
                </td>
                <td className="px-3 py-1">
                  {formatTokenAmount(order.amount, market?.base.decimals ?? 6)}{" "}
                  {market?.base.symbol}
                </td>
                <td className="px-3 py-1 text-text-muted">
                  {formatTokenAmount(order.filled, market?.base.decimals ?? 6)}
                </td>
                <td className="px-3 py-1">
                  <button
                    onClick={() => cancelOrder.mutate(order.orderId)}
                    disabled={cancelOrder.isPending}
                    className="text-sell hover:text-sell/80 disabled:opacity-40"
                  >
                    Cancel
                  </button>
                </td>
              </tr>
            ))}
            {orders?.length === 0 && (
              <tr>
                <td
                  colSpan={5}
                  className="px-3 py-4 text-center text-text-muted"
                >
                  No open orders
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
