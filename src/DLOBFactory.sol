// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) Parity Technologies (UK) Ltd.
pragma solidity ^0.8.20;

import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";
import {IXcm} from "./interfaces/IXcm.sol";
import {ISystem} from "./interfaces/ISystem.sol";
import {IDLOBFactory} from "./interfaces/IDLOBFactory.sol";
import {DLOB} from "./DLOB.sol";
import {TokenConfig} from "./types/TokenConfig.sol";

/// @title DLOBFactory
/// @notice Market registry and fee configuration for the DLOB protocol.
/// Creates EIP-1167 minimal proxy clones of a pre-deployed DLOB implementation.
contract DLOBFactory is IDLOBFactory {
    // ──────────────────────── State ──────────────────────────────

    mapping(bytes32 => address) public markets; // hash(base, quote) → DLOB address
    address[] public allMarkets;

    IXcm public immutable XCM_PRECOMPILE;
    ISystem public immutable SYSTEM_PRECOMPILE;
    address public immutable IMPLEMENTATION;
    address public admin;

    uint128 public minCrossChainFee;
    uint128 public marketCreationDeposit;

    // ──────────────────────── Events ─────────────────────────────

    event MarketCreated(
        address indexed baseToken, address indexed quoteToken, address dlob, uint256 deposit
    );
    event MinCrossChainFeeUpdated(uint128 feeInPlanck);
    event MarketCreationDepositUpdated(uint128 depositInPlanck);
    event AdminTransferred(address indexed oldAdmin, address indexed newAdmin);

    // ──────────────────────── Errors ─────────────────────────────

    error NotAdmin();
    error MarketExists();
    error InsufficientDeposit();
    error SameToken();
    error ZeroAddress();
    error ZeroTickSize();
    error ZeroMinOrderSize();
    error MaxBelowMin();

    // ──────────────────────── Constructor ─────────────────────────

    constructor(address _xcm, address _system, address _implementation) {
        XCM_PRECOMPILE = IXcm(_xcm);
        SYSTEM_PRECOMPILE = ISystem(_system);
        IMPLEMENTATION = _implementation;
        admin = msg.sender;
    }

    // ──────────────────────── Market Creation ────────────────────

    /// @notice Create a new DLOB market for a token pair.
    /// @param base Base token configuration. See `TokenConfig` for details on `xcmLocation`.
    /// @param quote Quote token configuration.
    function createMarket(
        TokenConfig calldata base,
        TokenConfig calldata quote,
        uint96 tickSize,
        uint96 minOrderSize,
        uint128 maxOrderSize
    ) external payable returns (address dlob) {
        if (base.token == quote.token) revert SameToken();
        if (base.token == address(0) || quote.token == address(0)) revert ZeroAddress();
        if (tickSize == 0) revert ZeroTickSize();
        if (minOrderSize == 0) revert ZeroMinOrderSize();
        if (maxOrderSize < minOrderSize) revert MaxBelowMin();
        if (msg.value < marketCreationDeposit) revert InsufficientDeposit();

        (address tokenA, address tokenB) =
            base.token < quote.token ? (base.token, quote.token) : (quote.token, base.token);
        bytes32 key = keccak256(abi.encodePacked(tokenA, tokenB));
        if (markets[key] != address(0)) revert MarketExists();

        dlob = Clones.clone(IMPLEMENTATION);
        DLOB(payable(dlob)).initialize{value: msg.value}(
            base, quote, tickSize, minOrderSize, maxOrderSize,
            address(XCM_PRECOMPILE), address(SYSTEM_PRECOMPILE), address(this)
        );

        markets[key] = dlob;
        allMarkets.push(dlob);

        emit MarketCreated(base.token, quote.token, dlob, msg.value);
    }

    // ──────────────────────── Admin Functions ────────────────────

    function setMinCrossChainFee(uint128 feeInPlanck) external {
        if (msg.sender != admin) revert NotAdmin();
        minCrossChainFee = feeInPlanck;
        emit MinCrossChainFeeUpdated(feeInPlanck);
    }

    function setMarketCreationDeposit(uint128 depositInPlanck) external {
        if (msg.sender != admin) revert NotAdmin();
        marketCreationDeposit = depositInPlanck;
        emit MarketCreationDepositUpdated(depositInPlanck);
    }

    function transferAdmin(address newAdmin) external {
        if (msg.sender != admin) revert NotAdmin();
        if (newAdmin == address(0)) revert ZeroAddress();
        emit AdminTransferred(admin, newAdmin);
        admin = newAdmin;
    }

    // ──────────────────────── View Functions ─────────────────────

    function getMarket(address base, address quote) external view returns (address) {
        (address tokenA, address tokenB) = base < quote ? (base, quote) : (quote, base);
        return markets[keccak256(abi.encodePacked(tokenA, tokenB))];
    }

    function getMarketCount() external view returns (uint256) {
        return allMarkets.length;
    }

    function getMarketAt(uint256 index) external view returns (address) {
        return allMarkets[index];
    }
}
