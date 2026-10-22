// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: © 2026 Parity Technologies
import { useRef } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { PriceLevel } from "./PriceLevel";
import { Side, type OrderBookLevel } from "../../types/market";

interface OrderBookSideProps {
  levels: OrderBookLevel[];
  side: Side;
  maxTotal: bigint;
  baseDecimals: number;
  priceDecimals: number;
  /** Which edge the rows stick to when there are too few to fill the area — "bottom" makes asks
   *  hug the spread (best/lowest ask nearest it), "top" makes bids hug it. */
  anchor?: "top" | "bottom";
}

export function OrderBookSide({ levels, side, maxTotal, baseDecimals, priceDecimals, anchor = "top" }: OrderBookSideProps) {
  const parentRef = useRef<HTMLDivElement>(null);

  const virtualizer = useVirtualizer({
    count: levels.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 24,
    overscan: 5,
  });

  return (
    <div
      ref={parentRef}
      // Reserve the 6px scrollbar gutter on both sides whether or not they scroll, so the right-aligned
      // Volume column always lines up with the header (which mirrors the same inset). Without it, an
      // overflowing side would shift 6px left of a non-overflowing one.
      className={`flex max-h-48 shrink-0 flex-col overflow-y-auto [scrollbar-gutter:stable] lg:max-h-72 lg:shrink ${anchor === "bottom" ? "justify-end" : ""}`}
    >
      <div
        className="relative w-full shrink-0"
        style={{ height: `${virtualizer.getTotalSize()}px` }}
      >
        {virtualizer.getVirtualItems().map((virtualRow) => {
          const level = levels[virtualRow.index]!;
          return (
            <div
              key={virtualRow.key}
              className="absolute left-0 top-0 w-full"
              style={{
                height: `${virtualRow.size}px`,
                transform: `translateY(${virtualRow.start}px)`,
              }}
            >
              <PriceLevel level={level} side={side} maxTotal={maxTotal} baseDecimals={baseDecimals} priceDecimals={priceDecimals} />
            </div>
          );
        })}
      </div>
    </div>
  );
}
