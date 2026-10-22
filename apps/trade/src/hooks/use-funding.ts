// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: © 2026 Parity Technologies
import { useWalletStore } from "../stores/wallet";
import { useNativeBalance } from "./use-native-balance";
import { useNativeToken } from "./use-native-token";
import { feeWarningThreshold } from "../lib/format";

/**
 * Whether the connected account has enough native token to act. A new account starts with none, and
 * without it every write fails, even claiming test tokens: fees and storage deposits are paid in the
 * native token (a host may sponsor gas, never the deposits), and receiving a non-sufficient asset like
 * tUSD requires the account to exist. `address` is where to send the native token: the SS58 address of
 * a host or Substrate account, the H160 of an EVM account.
 */
export function useFunding() {
  const accountType = useWalletStore((s) => s.accountType);
  const ss58 = useWalletStore((s) => s.ss58);
  const h160 = useWalletStore((s) => s.h160);
  const { data: free } = useNativeBalance();
  const { data: token } = useNativeToken();
  const low = free !== undefined && token !== undefined && free < feeWarningThreshold(token.decimals);
  const address = accountType === "evm" ? h160 : ss58;
  return { low, free, token, address };
}
