// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: © 2026 Parity Technologies
import { Side, type OrderBookLevel } from "../../types/market";
import { formatTokenAmount } from "../../lib/format";
import { useTradeFormStore } from "../../stores/trade-form";

interface PriceLevelProps {
  level: OrderBookLevel;
  side: Side;
  maxTotal: bigint;
  baseDecimals: number;
  priceDecimals: number;
}

export function PriceLevel({ level, side, maxTotal, baseDecimals, priceDecimals }: PriceLevelProps) {
  const setPrice = useTradeFormStore((s) => s.setPrice);
  const depthPercent =
    maxTotal > 0n
      ? Number((level.totalAmount * 100n) / maxTotal)
      : 0;

  const colorClass = side === Side.Buy ? "text-buy" : "text-sell";
  const barColor = side === Side.Buy ? "bg-buy-dim" : "bg-sell-dim";

  return (
    <button
      onClick={() => setPrice(formatTokenAmount(level.price, 18, priceDecimals))}
      className="relative grid w-full grid-cols-2 gap-1 px-3 text-left text-xs hover:bg-surface-overlay"
    >
      {/* Depth bar */}
      <div
        className={`absolute inset-y-0 right-0 ${barColor}`}
        style={{ width: `${Math.min(depthPercent, 100)}%` }}
      />
      <span className={`relative z-10 ${colorClass}`}>
        {formatTokenAmount(level.price, 18, priceDecimals)}
      </span>
      <span className="relative z-10 text-right text-text-primary">
        {formatTokenAmount(level.totalAmount, baseDecimals)}
      </span>
    </button>
  );
}
