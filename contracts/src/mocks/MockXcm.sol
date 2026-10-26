// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: © 2026 Parity Technologies
pragma solidity ^0.8.20;

import {IXcm} from "../interfaces/IXcm.sol";

/// @title MockXcm
/// @notice Stands in for the XCM precompile (0xA0000) during local testing.
/// Records execute() and send() calls for test verification.
contract MockXcm is IXcm {
    struct ExecuteCall {
        bytes message;
        Weight weight;
    }

    struct SendCall {
        bytes destination;
        bytes message;
    }

    ExecuteCall[] public executeCalls;
    SendCall[] public sendCalls;
    bool public shouldRevert;
    bool public weighShouldRevert;

    event XcmExecuted(bytes message);
    event XcmSent(bytes destination, bytes message);

    function execute(bytes calldata message, Weight calldata weight) external override {
        require(!shouldRevert, "MockXcm: execute reverted");
        executeCalls.push(ExecuteCall(message, weight));
        emit XcmExecuted(message);
    }

    function send(bytes calldata destination, bytes calldata message) external override {
        sendCalls.push(SendCall(destination, message));
        emit XcmSent(destination, message);
    }

    function weighMessage(bytes calldata) external view override returns (Weight memory weight) {
        require(!weighShouldRevert, "MockXcm: weighMessage reverted");
        weight = Weight({refTime: 1_000_000_000, proofSize: 100_000});
    }

    // --- Test helpers ---

    function setShouldRevert(bool _shouldRevert) external {
        shouldRevert = _shouldRevert;
    }

    /// @notice Make `weighMessage` revert, as the precompile does for a message it cannot decode.
    function setWeighShouldRevert(bool _weighShouldRevert) external {
        weighShouldRevert = _weighShouldRevert;
    }

    function getExecuteCallCount() external view returns (uint256) {
        return executeCalls.length;
    }

    function getExecuteCall(uint256 i) external view returns (bytes memory, Weight memory) {
        return (executeCalls[i].message, executeCalls[i].weight);
    }

    function getSendCallCount() external view returns (uint256) {
        return sendCalls.length;
    }

    function reset() external {
        delete executeCalls;
        delete sendCalls;
        shouldRevert = false;
        weighShouldRevert = false;
    }
}
