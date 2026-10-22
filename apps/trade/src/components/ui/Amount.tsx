// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: © 2026 Parity Technologies
import { formatTokenAmount, groupThousands } from "../../lib/format";

/**
 * Render a token amount with a grouped integer part and a smaller, dimmed fraction (e.g. 10'981·00).
 * `display` defaults to 2 decimals — enough for assets (tUSD, tMU, tNVDA) in the trade UI. The fraction
 * uses a relative `em` size so it scales with the surrounding font (large in the header, small inline).
 */
export function Amount({
  value,
  decimals,
  display = 2,
}: {
  value: bigint;
  decimals: number;
  display?: number;
}) {
  const [intPart, frac] = groupThousands(formatTokenAmount(value, decimals, display)).split(".");
  return (
    <span className="tabular-nums">
      {intPart}
      {frac !== undefined && <span className="text-[0.72em] opacity-70">.{frac}</span>}
    </span>
  );
}
