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
}

export function OrderBookSide({ levels, side, maxTotal, baseDecimals, priceDecimals }: OrderBookSideProps) {
  const parentRef = useRef<HTMLDivElement>(null);

  const virtualizer = useVirtualizer({
    count: levels.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 22,
    overscan: 5,
  });

  return (
    <div ref={parentRef} className="h-full overflow-y-auto">
      <div
        className="relative w-full"
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
