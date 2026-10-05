// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) Parity Technologies (UK) Ltd.
pragma solidity ^0.8.20;

import {Script, console} from "forge-std/Script.sol";
import {Faucet} from "../src/Faucet.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @notice Deploys the tUSD demo Faucet.
/// @dev `scripts/bootstrap.mjs` runs this and funds the faucet. To run it by hand (MUST pass --rpc-url
///      to actually broadcast; `polkadot-testnet` is only an [etherscan] alias, not an RPC endpoint):
///   TUSD_ADDRESS=0x0120... FAUCET_DRIP=<raw> FAUCET_COOLDOWN=<secs> \
///     forge script script/DeployFaucet.s.sol --rpc-url "$RPC_URL" \
///     --private-key $DEPLOYER_PRIVATE_KEY --broadcast
///
/// After deploying, pre-fund it: the tUSD asset admin mints tUSD to the printed Faucet address (the drip
/// is finite; refill the same way). FAUCET_DRIP is in tUSD base units, i.e. 10000 * 10**(tUSD decimals).
contract DeployFaucet is Script {
    function run() external {
        address token = vm.envAddress("TUSD_ADDRESS");
        // Defaults assume tUSD has 6 decimals; override FAUCET_DRIP once confirmed.
        uint256 drip = vm.envOr("FAUCET_DRIP", uint256(10_000) * 1e6);
        uint256 cooldown = vm.envOr("FAUCET_COOLDOWN", uint256(24 hours));

        vm.startBroadcast();
        Faucet faucet = new Faucet(IERC20(token), drip, cooldown);
        vm.stopBroadcast();

        console.log("Faucet:  ", address(faucet));
        console.log("tUSD:    ", token);
        console.log("Drip:    ", drip);
        console.log("Cooldown:", cooldown);
        console.log("Next: mint tUSD to the Faucet address above to fund it.");
    }
}
