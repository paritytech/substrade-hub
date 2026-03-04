// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) Parity Technologies (UK) Ltd.
pragma solidity ^0.8.20;

interface IDLOBFactory {
    function admin() external view returns (address);
    function minCrossChainFee() external view returns (uint128);
    function getMarket(address base, address quote) external view returns (address);
    function getMarketCount() external view returns (uint256);
}
