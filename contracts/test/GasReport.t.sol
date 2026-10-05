// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: © 2026 Parity Technologies
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";
import {DLOBFactory} from "../src/DLOBFactory.sol";
import {DLOB} from "../src/DLOB.sol";
import {MockERC20} from "../src/mocks/MockERC20.sol";
import {MockXcm} from "../src/mocks/MockXcm.sol";
import {MockSystem} from "../src/mocks/MockSystem.sol";
import {TokenConfig} from "../src/types/TokenConfig.sol";

contract GasReportTest is Test {
    DLOBFactory public factory;
    DLOB public dlob;
    MockXcm public mockXcm;
    MockSystem public mockSystem;
    MockERC20 public baseToken;
    MockERC20 public quoteToken;

    address alice = address(0xA11CE);
    address bob = address(0xB0B);

    uint96 constant TICK_SIZE = 1e15;
    uint96 constant MIN_ORDER_SIZE = 1e6;
    uint128 constant MAX_ORDER_SIZE = 1e24;
    uint256 constant PRECISION = 1e18;

    function setUp() public {
        mockXcm = new MockXcm();
        mockSystem = new MockSystem();
        DLOB impl = new DLOB();
        factory = new DLOBFactory(address(mockXcm), address(mockSystem), address(impl));
        factory.setMinCrossChainFee(1e9);

        baseToken = new MockERC20("Base", "BASE");
        quoteToken = new MockERC20("Quote", "QUOTE");
        address dlobAddr = factory.createMarket(
            TokenConfig(address(baseToken), ""),
            TokenConfig(address(quoteToken), ""),
            TICK_SIZE,
            MIN_ORDER_SIZE,
            MAX_ORDER_SIZE
        );
        dlob = DLOB(payable(dlobAddr));

        baseToken.mint(alice, 1_000_000e18);
        baseToken.mint(bob, 1_000_000e18);
        quoteToken.mint(alice, 1_000_000e18);
        quoteToken.mint(bob, 1_000_000e18);

        vm.prank(alice);
        baseToken.approve(address(dlob), type(uint256).max);
        vm.prank(alice);
        quoteToken.approve(address(dlob), type(uint256).max);
        vm.prank(bob);
        baseToken.approve(address(dlob), type(uint256).max);
        vm.prank(bob);
        quoteToken.approve(address(dlob), type(uint256).max);

        vm.deal(alice, 100 ether);
        vm.deal(bob, 100 ether);
    }

    function testGasFirstOrder() public {
        vm.prank(alice);
        dlob.placeLimitOrder(
            DLOB.Side.Buy,
            50e15, // price
            100e6, // amount
            bytes32(0), // originAccount
            bytes32(0), // settlementAccount
            0, // destParaId
            0 // expireTimestamp (GTC)
        );
    }

    function testGasNewPriceLevel() public {
        // Place 5 orders at different prices
        vm.startPrank(alice);
        dlob.placeLimitOrder(DLOB.Side.Buy, 50e15, 100e6, bytes32(0), bytes32(0), 0, 0);
        dlob.placeLimitOrder(DLOB.Side.Buy, 51e15, 100e6, bytes32(0), bytes32(0), 0, 0);
        dlob.placeLimitOrder(DLOB.Side.Buy, 52e15, 100e6, bytes32(0), bytes32(0), 0, 0);
        dlob.placeLimitOrder(DLOB.Side.Buy, 53e15, 100e6, bytes32(0), bytes32(0), 0, 0);
        dlob.placeLimitOrder(DLOB.Side.Buy, 54e15, 100e6, bytes32(0), bytes32(0), 0, 0);

        // Place one more at a new price level
        dlob.placeLimitOrder(DLOB.Side.Buy, 55e15, 100e6, bytes32(0), bytes32(0), 0, 0);
        vm.stopPrank();
    }

    function testGasExistingPriceLevel() public {
        vm.startPrank(alice);
        // Place first order at a price level
        dlob.placeLimitOrder(DLOB.Side.Buy, 50e15, 100e6, bytes32(0), bytes32(0), 0, 0);

        // Place second order at the same price level (enqueue)
        dlob.placeLimitOrder(DLOB.Side.Buy, 50e15, 100e6, bytes32(0), bytes32(0), 0, 0);
        vm.stopPrank();
    }

    function testGasWithLocalMatch() public {
        // Place a sell order
        vm.prank(bob);
        dlob.placeLimitOrder(DLOB.Side.Sell, 50e15, 100e6, bytes32(0), bytes32(0), 0, 0);

        // Place a buy order that matches (local settlement)
        vm.prank(alice);
        dlob.placeLimitOrder(DLOB.Side.Buy, 50e15, 100e6, bytes32(0), bytes32(0), 0, 0);
    }

    function testGasWithCrossChainMatchInline() public {
        // Cross-chain maker resting (bob)
        vm.prank(bob);
        dlob.placeLimitOrder{value: 1e9}(
            DLOB.Side.Sell,
            50e15, // price
            100e6, // amount
            bytes32(uint256(2)), // originAccount
            bytes32(uint256(0xB0B)), // settlementAccount
            1000, // destParaId
            0 // expireTimestamp (GTC)
        );

        // Local taker matches (alice) - inline XCM
        vm.prank(alice);
        dlob.placeLimitOrder(DLOB.Side.Buy, 50e15, 100e6, bytes32(0), bytes32(0), 0, 0);
    }

    function testGasWithCrossChainMatchFallback() public {
        // Set MockXcm to revert (fallback to claim)
        mockXcm.setShouldRevert(true);

        // Cross-chain maker resting (bob)
        vm.prank(bob);
        dlob.placeLimitOrder{value: 1e9}(
            DLOB.Side.Sell,
            50e15, // price
            100e6, // amount
            bytes32(uint256(2)), // originAccount
            bytes32(uint256(0xB0B)), // settlementAccount
            1000, // destParaId
            0 // expireTimestamp (GTC)
        );

        // Local taker matches (alice) - creates fallback claim
        vm.prank(alice);
        dlob.placeLimitOrder(DLOB.Side.Buy, 50e15, 100e6, bytes32(0), bytes32(0), 0, 0);

        // Reset for other tests
        mockXcm.setShouldRevert(false);
    }

    function testGasClaimSettlement() public {
        // Set MockXcm to revert to create a pending claim
        mockXcm.setShouldRevert(true);

        // Cross-chain maker resting (bob)
        vm.prank(bob);
        uint32 orderId = dlob.placeLimitOrder{value: 1e9}(
            DLOB.Side.Sell,
            50e15, // price
            100e6, // amount
            bytes32(uint256(2)), // originAccount
            bytes32(uint256(0xB0B)), // settlementAccount
            1000, // destParaId
            0 // expireTimestamp (GTC)
        );

        // Local taker matches (alice) - creates fallback claim
        vm.prank(alice);
        dlob.placeLimitOrder(DLOB.Side.Buy, 50e15, 100e6, bytes32(0), bytes32(0), 0, 0);

        // Reset MockXcm
        mockXcm.setShouldRevert(false);

        // Claim settlement (claimId is the orderId for the maker)
        vm.prank(bob);
        dlob.claimSettlement{value: 1e9}(orderId);
    }

    function testGasCancelOrder() public {
        // Place a local order
        vm.prank(alice);
        uint32 orderId = dlob.placeLimitOrder(
            DLOB.Side.Buy,
            50e15, // price
            100e6, // amount
            bytes32(0), // originAccount
            bytes32(0), // settlementAccount
            0, // destParaId
            0 // expireTimestamp (GTC)
        );

        // Cancel the order
        vm.prank(alice);
        dlob.cancelOrder(orderId, bytes32(0));
    }

    function testGasCancelCrossChainOrder() public {
        // Place a cross-chain order
        vm.prank(bob);
        uint32 orderId = dlob.placeLimitOrder{value: 1e9}(
            DLOB.Side.Sell,
            50e15, // price
            100e6, // amount
            bytes32(uint256(2)), // originAccount
            bytes32(uint256(0xB0B)), // settlementAccount
            1000, // destParaId
            0 // expireTimestamp (GTC)
        );

        // Cancel the cross-chain order (creates refund claim)
        vm.prank(bob);
        dlob.cancelOrder(orderId, bytes32(uint256(2)));
    }

    function testGasReduceOrder() public {
        // Place a local order
        vm.prank(alice);
        uint32 orderId = dlob.placeLimitOrder(
            DLOB.Side.Buy,
            50e15, // price
            100e6, // amount
            bytes32(0), // originAccount
            bytes32(0), // settlementAccount
            0, // destParaId
            0 // expireTimestamp (GTC)
        );

        // Reduce the order
        vm.prank(alice);
        dlob.reduceOrder(orderId, 50e6, bytes32(0));
    }

    function testGasMatchWithExpiredOrders() public {
        // Set initial timestamp
        vm.warp(1000);

        // Place 5 sell orders with expireTimestamp=1500
        vm.startPrank(bob);
        dlob.placeLimitOrder(DLOB.Side.Sell, 50e15, 100e6, bytes32(0), bytes32(0), 0, 1500);
        dlob.placeLimitOrder(DLOB.Side.Sell, 50e15, 100e6, bytes32(0), bytes32(0), 0, 1500);
        dlob.placeLimitOrder(DLOB.Side.Sell, 50e15, 100e6, bytes32(0), bytes32(0), 0, 1500);
        dlob.placeLimitOrder(DLOB.Side.Sell, 50e15, 100e6, bytes32(0), bytes32(0), 0, 1500);
        dlob.placeLimitOrder(DLOB.Side.Sell, 50e15, 100e6, bytes32(0), bytes32(0), 0, 1500);

        // Place 1 sell order with expireTimestamp=0 (GTC)
        dlob.placeLimitOrder(DLOB.Side.Sell, 50e15, 100e6, bytes32(0), bytes32(0), 0, 0);
        vm.stopPrank();

        // Warp time so the 5 orders are expired
        vm.warp(2000);

        // Alice places buy - should skip 5 expired, match the 1 valid
        vm.prank(alice);
        dlob.placeLimitOrder(DLOB.Side.Buy, 50e15, 100e6, bytes32(0), bytes32(0), 0, 0);
    }

    function testGas10OrderMatch() public {
        // Create 10 different sellers to avoid self-trade
        for (uint256 i = 1; i <= 10; i++) {
            address seller = vm.addr(i);
            baseToken.mint(seller, 1_000_000e18);
            vm.prank(seller);
            baseToken.approve(address(dlob), type(uint256).max);

            // Place sell order at 50e15 for 100e6 each
            vm.prank(seller);
            dlob.placeLimitOrder(DLOB.Side.Sell, 50e15, 100e6, bytes32(0), bytes32(0), 0, 0);
        }

        // Alice buys 1000e6 at 50e15 (fills all 10 orders)
        vm.prank(alice);
        dlob.placeLimitOrder(DLOB.Side.Buy, 50e15, 1000e6, bytes32(0), bytes32(0), 0, 0);
    }
}
