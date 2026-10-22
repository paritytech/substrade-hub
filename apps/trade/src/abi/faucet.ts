// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: © 2026 Parity Technologies
// Minimal ABI for the demo tUSD Faucet (contracts/src/Faucet.sol).
export const faucetAbi = [
  { type: "function", name: "claim", inputs: [], outputs: [], stateMutability: "nonpayable" },
  {
    type: "function",
    name: "claimableIn",
    inputs: [{ name: "who", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "dripAmount",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "cooldown",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
  },
  { type: "error", name: "CooldownActive", inputs: [{ name: "retryAt", type: "uint256" }] },
  { type: "error", name: "FaucetEmpty", inputs: [] },
  { type: "error", name: "NotOwner", inputs: [] },
] as const;
