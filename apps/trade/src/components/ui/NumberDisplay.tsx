// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: © 2026 Parity Technologies
import { formatTokenAmount } from "../../lib/format";

interface NumberDisplayProps {
  value: bigint;
  decimals?: number;
  displayDecimals?: number;
  className?: string;
}

export function NumberDisplay({
  value,
  decimals = 18,
  displayDecimals = 4,
  className,
}: NumberDisplayProps) {
  return (
    <span className={className}>
      {formatTokenAmount(value, decimals, displayDecimals)}
    </span>
  );
}
