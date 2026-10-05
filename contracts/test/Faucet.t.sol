// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: © 2026 Parity Technologies
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";
import {Faucet} from "../src/Faucet.sol";
import {MockERC20} from "../src/mocks/MockERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

contract FaucetTest is Test {
    Faucet faucet;
    MockERC20 token;

    uint256 constant DRIP = 10_000e18;
    uint256 constant COOLDOWN = 24 hours;
    address alice = address(0xA11CE);
    address bob = address(0xB0B);

    function setUp() public {
        token = new MockERC20("Test USD", "tUSD");
        faucet = new Faucet(IERC20(address(token)), DRIP, COOLDOWN);
        token.mint(address(faucet), 1_000_000e18);
    }

    function testFirstClaimSendsDrip() public {
        vm.prank(alice);
        faucet.claim();
        assertEq(token.balanceOf(alice), DRIP);
        assertEq(faucet.claimableIn(alice), COOLDOWN);
    }

    function testCooldownBlocksImmediateSecondClaim() public {
        vm.startPrank(alice);
        faucet.claim();
        vm.expectRevert(
            abi.encodeWithSelector(Faucet.CooldownActive.selector, block.timestamp + COOLDOWN)
        );
        faucet.claim();
        vm.stopPrank();
    }

    function testClaimAgainExactlyAfterCooldown() public {
        vm.startPrank(alice);
        faucet.claim();
        vm.warp(block.timestamp + COOLDOWN);
        faucet.claim();
        vm.stopPrank();
        assertEq(token.balanceOf(alice), 2 * DRIP);
    }

    function testCooldownIsPerAddress() public {
        vm.prank(alice);
        faucet.claim();
        vm.prank(bob);
        faucet.claim();
        assertEq(token.balanceOf(alice), DRIP);
        assertEq(token.balanceOf(bob), DRIP);
    }

    function testRevertsWhenEmpty() public {
        faucet.withdraw(address(this), token.balanceOf(address(faucet)));
        vm.prank(alice);
        vm.expectRevert(Faucet.FaucetEmpty.selector);
        faucet.claim();
    }

    function testOnlyOwnerCanWithdraw() public {
        vm.prank(alice);
        vm.expectRevert(Faucet.NotOwner.selector);
        faucet.withdraw(alice, 1);
    }

    function testOnlyOwnerCanSetDrip() public {
        vm.prank(alice);
        vm.expectRevert(Faucet.NotOwner.selector);
        faucet.setDrip(1, 1);
    }

    function testSetDripTakesEffect() public {
        faucet.setDrip(500e18, 30 minutes);
        vm.prank(alice);
        faucet.claim();
        assertEq(token.balanceOf(alice), 500e18);
    }
}
