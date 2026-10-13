import { useQuery } from "@tanstack/react-query";
import { AccountId } from "polkadot-api";
import { fromHex } from "polkadot-api/utils";
import { getTypedApi } from "../lib/client";
import { useWalletStore } from "../stores/wallet";
import { POLL_INTERVAL_MS } from "../config/constants";

const ss58 = AccountId(42);

/**
 * Free native balance (planck) of the connected account, whatever its kind: a host or Substrate account
 * is its own AccountId32, and an EVM account is pallet-revive's `H160 ++ 0xEE * 12` account, which is
 * where its native balance lives. Every write spends from it: network fees, and storage deposits that
 * gas sponsoring does not cover.
 */
export function useNativeBalance() {
  const originAccount = useWalletStore((s) => s.originAccount);
  return useQuery({
    queryKey: ["nativeBalance", originAccount],
    queryFn: async (): Promise<bigint> => {
      const info = await getTypedApi().query.System.Account.getValue(ss58.dec(fromHex(originAccount!)));
      return info.data.free;
    },
    enabled: !!originAccount,
    refetchInterval: POLL_INTERVAL_MS,
  });
}
