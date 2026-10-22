// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: © 2026 Parity Technologies
import { useQuery } from "@tanstack/react-query";
import { readContract } from "../lib/contract";
import { erc20Abi } from "../abi/erc20";
import { POLL_INTERVAL_MS } from "../config/constants";

/** The query for `account`'s balance of `tokenAddress`, shared by every view that shows it. */
export function tokenBalanceQuery(tokenAddress: `0x${string}` | undefined, account: `0x${string}` | undefined) {
  return {
    queryKey: ["tokenBalance", tokenAddress, account],
    queryFn: () =>
      readContract(
        erc20Abi,
        "balanceOf",
        [account!],
        tokenAddress!,
      ) as Promise<bigint>,
    enabled: !!tokenAddress && !!account,
    refetchInterval: POLL_INTERVAL_MS,
  };
}

export function useTokenBalance(
  tokenAddress: `0x${string}` | undefined,
  account: `0x${string}` | undefined,
) {
  return useQuery(tokenBalanceQuery(tokenAddress, account));
}
