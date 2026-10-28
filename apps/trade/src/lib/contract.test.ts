// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: © 2026 Parity Technologies
import { afterEach, describe, expect, it } from "vitest";
import { writeContract } from "./contract";
import { erc20Abi } from "../abi/erc20";
import { useWalletStore } from "../stores/wallet";

const A = "0x1111111111111111111111111111111111111111" as const;
const B = "0x2222222222222222222222222222222222222222" as const;

describe("writeContract", () => {
  afterEach(() => useWalletStore.setState({ h160: null }));

  it("refuses a call built for another account than the connected one", async () => {
    // A multi-part order built for A, while the wallet has since switched to B.
    useWalletStore.setState({ h160: B });
    await expect(writeContract(erc20Abi, "approve", [A, 1n], A, A)).rejects.toThrow(
      "The connected account changed. Check your orders, then try again.",
    );
  });

  it("refuses when no account is connected", async () => {
    await expect(writeContract(erc20Abi, "approve", [A, 1n], A, A)).rejects.toThrow("The connected account changed.");
  });
});
