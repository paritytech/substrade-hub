// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) Parity Technologies (UK) Ltd.
pragma solidity ^0.8.20;

import {ISystem} from "../interfaces/ISystem.sol";

/// @title MockSystem
/// @notice Stands in for the System precompile (0x900) during local testing.
contract MockSystem is ISystem {
    function hashBlake256(bytes memory input) external pure override returns (bytes32) {
        return keccak256(input);
    }

    function hashBlake128(bytes memory input) external pure override returns (bytes32) {
        return keccak256(input);
    }

    function toAccountId(address) external pure override returns (bytes memory) {
        revert("MockSystem: toAccountId not implemented");
    }

    function callerIsOrigin() external pure override returns (bool) {
        return true;
    }

    function callerIsRoot() external pure override returns (bool) {
        return false;
    }

    function minimumBalance() external pure override returns (uint256) {
        return 1;
    }

    function ownCodeHash() external pure override returns (bytes32) {
        return bytes32(0);
    }

    function weightLeft() external pure override returns (uint64, uint64) {
        return (1_000_000_000, 1_000_000);
    }

    function terminate(address) external pure override {
        revert("MockSystem: terminate not implemented");
    }

    function sr25519Verify(uint8[64] calldata, bytes calldata, bytes32)
        external
        pure
        override
        returns (bool)
    {
        revert("MockSystem: sr25519Verify not implemented");
    }

    function ecdsaToEthAddress(uint8[33] calldata) external pure override returns (bytes20) {
        revert("MockSystem: ecdsaToEthAddress not implemented");
    }
}
