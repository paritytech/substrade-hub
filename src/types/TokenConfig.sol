// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) Parity Technologies (UK) Ltd.
pragma solidity ^0.8.20;

/// @notice Configuration for a token in a DLOB market.
///
/// Two modes depending on `xcmLocation`:
///
/// 1. **Pallet asset** (trust-backed, ERC20 precompile prefix 0x0120):
///    Leave `xcmLocation` empty. The contract derives the XCM Location on-chain
///    from the precompile address:
///    `Location { parents: 0, interior: X2(PalletInstance(50), GeneralIndex(assetId)) }`
///
/// 2. **Foreign asset** (ERC20 precompile prefix 0x0220, or other):
///    Provide the SCALE-encoded XCM Location that identifies the asset on-chain.
///    The contract stores it as-is and uses it for cross-chain settlement.
///
///    WARNING: The contract cannot validate that a foreign asset location is correct.
///    An incorrect location will cause cross-chain settlement to fail or deliver
///    tokens to the wrong destination. See the "Configuring XCM Locations" section
///    in docs/how-it-works.md for encoding guidance.
struct TokenConfig {
    address token;
    bytes xcmLocation;
}
