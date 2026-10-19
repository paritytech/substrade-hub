// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: © 2026 Parity Technologies
pragma solidity ^0.8.20;

interface IDLOBFactory {
    function admin() external view returns (address);
    function minCrossChainFee() external view returns (uint128);
    function halted() external view returns (bool);
    function getMarket(address base, address quote) external view returns (address);
    function getMarketCount() external view returns (uint256);
}
