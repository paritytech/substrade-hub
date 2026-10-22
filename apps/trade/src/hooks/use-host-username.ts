// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: © 2026 Parity Technologies
import { useQuery } from "@tanstack/react-query";
import { getHostUsername } from "../lib/host/signer";
import { useWalletStore } from "../stores/wallet";

/** The host user's username for the connected host account; `null` for other accounts or none. */
export function useHostUsername(): string | null {
  const { accountType, ss58 } = useWalletStore();
  const { data } = useQuery({
    queryKey: ["hostUsername", ss58],
    queryFn: getHostUsername,
    enabled: accountType === "host" && !!ss58,
    staleTime: Infinity,
  });
  return accountType === "host" ? (data ?? null) : null;
}
