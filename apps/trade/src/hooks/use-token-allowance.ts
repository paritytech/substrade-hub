// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: © 2026 Parity Technologies
import { useQuery } from "@tanstack/react-query";
import { readContract } from "../lib/contract";
import { erc20Abi } from "../abi/erc20";
import { POLL_INTERVAL_MS } from "../config/constants";

export function useTokenAllowance(
  tokenAddress: `0x${string}` | undefined,
  owner: `0x${string}` | undefined,
  spender: `0x${string}` | undefined,
) {
  return useQuery({
    queryKey: ["tokenAllowance", tokenAddress, owner, spender],
    queryFn: () =>
      readContract(
        erc20Abi,
        "allowance",
        [owner!, spender!],
        tokenAddress!,
      ) as Promise<bigint>,
    enabled: !!tokenAddress && !!owner && !!spender,
    refetchInterval: POLL_INTERVAL_MS,
  });
}
