// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: © 2026 Parity Technologies
import { describe, it, expect } from "vitest";
import { shortestRangeWithTrades, RANGE_SECONDS, HISTORY_BLOCKS, BLOCK_SECONDS } from "./chart";

const NOW = 2_000_000_000;

describe("shortestRangeWithTrades", () => {
  it("picks 1H when a trade is in the last hour", () => {
    expect(shortestRangeWithTrades([NOW - 10 * 86_400, NOW - 60], NOW)).toBe("1H");
  });

  it("picks the shortest window that still contains the latest trade", () => {
    expect(shortestRangeWithTrades([NOW - 2 * 3_600], NOW)).toBe("12H");
    expect(shortestRangeWithTrades([NOW - 3 * 86_400], NOW)).toBe("7D");
    expect(shortestRangeWithTrades([NOW - 8 * 86_400], NOW)).toBe("30D");
  });

  it("falls back to the longest range when there are no trades", () => {
    expect(shortestRangeWithTrades([], NOW)).toBe("30D");
  });
});

describe("HISTORY_BLOCKS", () => {
  it("covers the longest range at the network's block time", () => {
    expect(HISTORY_BLOCKS * BLOCK_SECONDS).toBe(RANGE_SECONDS["30D"]);
  });
});
