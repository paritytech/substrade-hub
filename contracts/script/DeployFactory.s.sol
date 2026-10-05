// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: © 2026 Parity Technologies
pragma solidity ^0.8.20;

import {Script, console} from "forge-std/Script.sol";
import {DLOBFactory} from "../src/DLOBFactory.sol";
import {DLOB} from "../src/DLOB.sol";

/// @notice Deploys the full SubsTrade Hub stack:
///         RedBlackTree + XcmBuilder (libraries) → DLOB implementation → DLOBFactory.
/// @dev Usage:
///   forge script script/DeployFactory.s.sol --chain polkadot-testnet --private-key $DEPLOYER_PRIVATE_KEY --broadcast
///   forge script script/DeployFactory.s.sol --chain polkadot --private-key $DEPLOYER_PRIVATE_KEY --broadcast
///
/// Outputs:
///   - Console logs with all deployed addresses
///   - broadcast/DeployFactory.s.sol/<chainId>/run-latest.json with full transaction receipts
///
/// Note: Forge auto-deploys the RedBlackTree and XcmBuilder libraries during broadcast
/// because DLOB references them as external (deployed) libraries. The library addresses
/// are resolved automatically, no --libraries flag is needed.
contract DeployFactory is Script {
    // Fixed precompile addresses on Asset Hub
    address constant XCM_PRECOMPILE = 0x00000000000000000000000000000000000a0000;
    address constant SYSTEM_PRECOMPILE = 0x0000000000000000000000000000000000000900;

    function run() external {
        vm.startBroadcast();

        // 1. Deploy DLOB implementation
        //    Forge automatically deploys the RedBlackTree and XcmBuilder libraries
        //    (referenced via delegatecall by DLOB) and links them into the bytecode
        //    before broadcasting.
        DLOB impl = new DLOB();

        // 2. Deploy DLOBFactory
        DLOBFactory factory = new DLOBFactory(XCM_PRECOMPILE, SYSTEM_PRECOMPILE, address(impl));

        vm.stopBroadcast();

        console.log("");
        console.log("=== Deployment Complete ===");
        console.log("DLOB_IMPL_ADDRESS=%s", address(impl));
        console.log("DLOB_FACTORY_ADDRESS=%s", address(factory));
        console.log("Admin:", factory.admin());
    }
}
