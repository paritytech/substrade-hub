// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: © 2026 Parity Technologies
import { useQuery } from "@tanstack/react-query";
import { getClient } from "../lib/client";

export interface NativeTokenInfo {
  decimals: number;
  symbol: string;
}

/**
 * Native token decimals + symbol, read from the chain spec (`system_properties`) rather than
 * hardcoded, so fee thresholds and labels are correct on whatever chain is connected
 * (e.g. Paseo AH reports `{ tokenDecimals: 10, tokenSymbol: "PAS" }`).
 */
export function useNativeToken() {
  return useQuery({
    queryKey: ["nativeToken"],
    queryFn: async (): Promise<NativeTokenInfo> => {
      const spec = await getClient().getChainSpecData();
      const props = (spec.properties ?? {}) as {
        tokenDecimals?: number | number[];
        tokenSymbol?: string | string[];
      };
      const decimals = Array.isArray(props.tokenDecimals)
        ? props.tokenDecimals[0]
        : props.tokenDecimals;
      const symbol = Array.isArray(props.tokenSymbol) ? props.tokenSymbol[0] : props.tokenSymbol;
      return { decimals: decimals ?? 10, symbol: symbol ?? "DOT" };
    },
    staleTime: Infinity, // chain properties don't change within a session
  });
}
