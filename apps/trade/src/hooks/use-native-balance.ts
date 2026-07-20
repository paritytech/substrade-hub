import { useQuery } from "@tanstack/react-query";
import type { SS58String } from "polkadot-api";
import { getTypedApi } from "../lib/client";
import { useWalletStore } from "../stores/wallet";
import { POLL_INTERVAL_MS } from "../config/constants";

/**
 * Free native DOT balance (planck, 10 decimals on Asset Hub) of the connected Substrate account.
 * Disabled (returns no data) for EVM or disconnected accounts. Used to warn about insufficient funds
 * for network fees before signing.
 */
export function useNativeBalance() {
  const accountType = useWalletStore((s) => s.accountType);
  const ss58 = useWalletStore((s) => s.ss58);
  return useQuery({
    queryKey: ["nativeBalance", ss58],
    queryFn: async (): Promise<bigint> => {
      const info = await getTypedApi().query.System.Account.getValue(ss58! as SS58String);
      return info.data.free;
    },
    enabled: accountType === "substrate" && !!ss58,
    refetchInterval: POLL_INTERVAL_MS,
  });
}
