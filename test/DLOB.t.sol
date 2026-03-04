// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) Parity Technologies (UK) Ltd.
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import "../src/DLOBFactory.sol";
import "../src/DLOB.sol";
import "../src/mocks/MockERC20.sol";
import "../src/mocks/MockXcm.sol";
import "../src/mocks/MockSystem.sol";

contract DLOBTest is Test {
    DLOBFactory public factory;
    DLOB public dlob;
    MockXcm public mockXcm;
    MockSystem public mockSystem;
    MockERC20 public baseToken;
    MockERC20 public quoteToken;

    address alice = address(0xA11CE);
    address bob = address(0xB0B);
    address charlie = address(0xC);

    uint96 constant TICK_SIZE = 1e15;
    uint96 constant MIN_ORDER_SIZE = 1e6;
    uint128 constant MAX_ORDER_SIZE = 1e24;
    uint256 constant PRECISION = 1e18;

    function setUp() public {
        mockXcm = new MockXcm();
        mockSystem = new MockSystem();
        DLOB impl = new DLOB();
        factory = new DLOBFactory(address(mockXcm), address(mockSystem), address(impl));
        factory.setMinCrossChainFee(1e9); // 0.000000001 DOT (1 planck unit for testing)

        baseToken = new MockERC20("Base", "BASE");
        quoteToken = new MockERC20("Quote", "QUOTE");
        address dlobAddr = factory.createMarket(
            address(baseToken), address(quoteToken), TICK_SIZE, MIN_ORDER_SIZE, MAX_ORDER_SIZE
        );
        dlob = DLOB(payable(dlobAddr));

        // Mint tokens
        baseToken.mint(alice, 1_000_000e18);
        baseToken.mint(bob, 1_000_000e18);
        baseToken.mint(charlie, 1_000_000e18);
        quoteToken.mint(alice, 1_000_000e18);
        quoteToken.mint(bob, 1_000_000e18);
        quoteToken.mint(charlie, 1_000_000e18);

        // Approvals
        vm.prank(alice);
        baseToken.approve(address(dlob), type(uint256).max);
        vm.prank(alice);
        quoteToken.approve(address(dlob), type(uint256).max);
        vm.prank(bob);
        baseToken.approve(address(dlob), type(uint256).max);
        vm.prank(bob);
        quoteToken.approve(address(dlob), type(uint256).max);
        vm.prank(charlie);
        baseToken.approve(address(dlob), type(uint256).max);
        vm.prank(charlie);
        quoteToken.approve(address(dlob), type(uint256).max);

        // Fund accounts with DOT for cross-chain tests
        vm.deal(alice, 100 ether);
        vm.deal(bob, 100 ether);
        vm.deal(charlie, 100 ether);
    }

    // ──────────────────── Placement Tests ─────────────────────

    function testPlaceBuyLimitOrder() public {
        vm.prank(alice);
        uint32 orderId = dlob.placeLimitOrder(
            DLOB.Side.Buy,
            50e15, // price: 0.05 in PRECISION
            100e6, // amount: 100 base units
            bytes32(0),
            bytes32(0),
            0,
            0
        );

        assertEq(orderId, 1);
        DLOB.Order memory o = dlob.getOrder(orderId);
        assertEq(o.owner, alice);
        assertEq(uint8(o.side), uint8(DLOB.Side.Buy));
        assertEq(o.price, 50e15);
        assertEq(o.remainingAmount, 100e6);
        assertEq(o.originalAmount, 100e6);

        (uint96 bid, uint96 ask) = dlob.getBestPrices();
        assertEq(bid, 50e15);
        assertEq(ask, 0);
    }

    function testPlaceSellLimitOrder() public {
        vm.prank(bob);
        uint32 orderId =
            dlob.placeLimitOrder(DLOB.Side.Sell, 60e15, 200e6, bytes32(0), bytes32(0), 0, 0);

        assertEq(orderId, 1);
        DLOB.Order memory o = dlob.getOrder(orderId);
        assertEq(o.owner, bob);
        assertEq(uint8(o.side), uint8(DLOB.Side.Sell));
        assertEq(o.remainingAmount, 200e6);

        (uint96 bid, uint96 ask) = dlob.getBestPrices();
        assertEq(bid, 0);
        assertEq(ask, 60e15);
    }

    function testPlaceCrossChainOrder() public {
        bytes32 settlement = bytes32(uint256(0xDEAD));
        vm.prank(alice);
        uint32 orderId = dlob.placeLimitOrder{value: 1e9}(
            DLOB.Side.Buy,
            50e15,
            100e6,
            bytes32(uint256(1)), // originAccount
            settlement,
            1000, // destParaId
            0
        );

        assertEq(dlob.getOrderFeeReserve(orderId), 1e9);
        assertEq(dlob.getSettlementAccount(orderId), settlement);
    }

    function testRevertTickAlignment() public {
        vm.prank(alice);
        vm.expectRevert(DLOB.NotTickAligned.selector);
        dlob.placeLimitOrder(
            DLOB.Side.Buy,
            50e15 + 1, // not aligned
            100e6,
            bytes32(0),
            bytes32(0),
            0,
            0
        );
    }

    function testRevertMinSize() public {
        vm.prank(alice);
        vm.expectRevert(DLOB.BelowMinSize.selector);
        dlob.placeLimitOrder(DLOB.Side.Buy, 50e15, MIN_ORDER_SIZE - 1, bytes32(0), bytes32(0), 0, 0);
    }

    function testRevertMaxSize() public {
        vm.prank(alice);
        vm.expectRevert(DLOB.AboveMaxSize.selector);
        dlob.placeLimitOrder(DLOB.Side.Buy, 50e15, MAX_ORDER_SIZE + 1, bytes32(0), bytes32(0), 0, 0);
    }

    function testRevertSettlementAccountMismatch() public {
        vm.prank(alice);
        vm.expectRevert(DLOB.InvalidSettlementAccount.selector);
        dlob.placeLimitOrder(
            DLOB.Side.Buy,
            50e15,
            100e6,
            bytes32(0),
            bytes32(uint256(1)), // non-zero settlement with destParaId=0
            0,
            0
        );
    }

    function testRevertMissingSettlementAccount() public {
        vm.prank(alice);
        vm.expectRevert(DLOB.InvalidSettlementAccount.selector);
        dlob.placeLimitOrder{value: 1e9}(
            DLOB.Side.Buy,
            50e15,
            100e6,
            bytes32(uint256(1)),
            bytes32(0), // zero settlement with destParaId>0
            1000,
            0
        );
    }

    function testRevertInsufficientFeeReserve() public {
        vm.prank(alice);
        vm.expectRevert(DLOB.InsufficientFeeReserve.selector);
        dlob.placeLimitOrder{value: 0}(
            DLOB.Side.Buy, 50e15, 100e6, bytes32(uint256(1)), bytes32(uint256(0xDEAD)), 1000, 0
        );
    }

    function testRevertLocalOrderWithValue() public {
        vm.prank(alice);
        vm.expectRevert(DLOB.LocalOrderWithValue.selector);
        dlob.placeLimitOrder{value: 1}(DLOB.Side.Buy, 50e15, 100e6, bytes32(0), bytes32(0), 0, 0);
    }

    function testRevertAlreadyExpired() public {
        vm.warp(1000);
        vm.prank(alice);
        vm.expectRevert(DLOB.AlreadyExpired.selector);
        dlob.placeLimitOrder(
            DLOB.Side.Buy,
            50e15,
            100e6,
            bytes32(0),
            bytes32(0),
            0,
            500 // already expired
        );
    }

    function testPlaceWithExpiry() public {
        vm.warp(1000);
        vm.prank(alice);
        uint32 orderId =
            dlob.placeLimitOrder(DLOB.Side.Buy, 50e15, 100e6, bytes32(0), bytes32(0), 0, 2000);

        DLOB.Order memory o = dlob.getOrder(orderId);
        assertEq(o.expireTimestamp, 2000);
    }

    // ──────────────────── Cancellation Tests ──────────────────

    function testCancelOwnOrder() public {
        vm.prank(alice);
        uint32 orderId =
            dlob.placeLimitOrder(DLOB.Side.Sell, 60e15, 100e6, bytes32(0), bytes32(0), 0, 0);

        uint256 balBefore = baseToken.balanceOf(alice);
        vm.prank(alice);
        dlob.cancelOrder(orderId, bytes32(0));

        assertEq(baseToken.balanceOf(alice), balBefore + 100e6);
        DLOB.Order memory o = dlob.getOrder(orderId);
        assertEq(uint8(o.status), uint8(DLOB.OrderStatus.Cancelled));
        assertEq(o.remainingAmount, 0);
    }

    function testRevertCancelOthersOrder() public {
        vm.prank(alice);
        uint32 orderId =
            dlob.placeLimitOrder(DLOB.Side.Sell, 60e15, 100e6, bytes32(0), bytes32(0), 0, 0);

        vm.prank(bob);
        vm.expectRevert(DLOB.NotOrderOwner.selector);
        dlob.cancelOrder(orderId, bytes32(0));
    }

    function testRevertCancelAlreadyCancelled() public {
        vm.prank(alice);
        uint32 orderId =
            dlob.placeLimitOrder(DLOB.Side.Sell, 60e15, 100e6, bytes32(0), bytes32(0), 0, 0);

        vm.prank(alice);
        dlob.cancelOrder(orderId, bytes32(0));

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(DLOB.OrderNotActive.selector, orderId));
        dlob.cancelOrder(orderId, bytes32(0));
    }

    function testBatchCancel() public {
        vm.startPrank(alice);
        uint32 id1 =
            dlob.placeLimitOrder(DLOB.Side.Sell, 60e15, 100e6, bytes32(0), bytes32(0), 0, 0);
        uint32 id2 =
            dlob.placeLimitOrder(DLOB.Side.Sell, 70e15, 200e6, bytes32(0), bytes32(0), 0, 0);
        vm.stopPrank();

        uint32[] memory ids = new uint32[](2);
        ids[0] = id1;
        ids[1] = id2;

        uint256 balBefore = baseToken.balanceOf(alice);
        vm.prank(alice);
        dlob.batchCancelOrders(ids, bytes32(0));

        assertEq(baseToken.balanceOf(alice), balBefore + 300e6);
    }

    // ──────────────────── Reduce Order Tests ─────────────────

    function testReduceLocalOrder() public {
        vm.prank(alice);
        uint32 orderId =
            dlob.placeLimitOrder(DLOB.Side.Sell, 60e15, 100e6, bytes32(0), bytes32(0), 0, 0);

        uint256 balBefore = baseToken.balanceOf(alice);
        vm.prank(alice);
        dlob.reduceOrder(orderId, 50e6, bytes32(0));

        assertEq(baseToken.balanceOf(alice), balBefore + 50e6);
        DLOB.Order memory o = dlob.getOrder(orderId);
        assertEq(o.remainingAmount, 50e6);
    }

    function testReduceBelowMinCancels() public {
        vm.prank(alice);
        uint32 orderId =
            dlob.placeLimitOrder(DLOB.Side.Sell, 60e15, 100e6, bytes32(0), bytes32(0), 0, 0);

        vm.prank(alice);
        dlob.reduceOrder(orderId, MIN_ORDER_SIZE / 2, bytes32(0));

        DLOB.Order memory o = dlob.getOrder(orderId);
        assertEq(uint8(o.status), uint8(DLOB.OrderStatus.Cancelled));
        assertEq(o.remainingAmount, 0);
    }

    function testRevertReduceIncrease() public {
        vm.prank(alice);
        uint32 orderId =
            dlob.placeLimitOrder(DLOB.Side.Sell, 60e15, 100e6, bytes32(0), bytes32(0), 0, 0);

        vm.prank(alice);
        vm.expectRevert(DLOB.ReduceOnly.selector);
        dlob.reduceOrder(orderId, 200e6, bytes32(0));
    }

    function testRevertReduceToZero() public {
        vm.prank(alice);
        uint32 orderId =
            dlob.placeLimitOrder(DLOB.Side.Sell, 60e15, 100e6, bytes32(0), bytes32(0), 0, 0);

        vm.prank(alice);
        vm.expectRevert(DLOB.ReduceToZero.selector);
        dlob.reduceOrder(orderId, 0, bytes32(0));
    }

    // ──────────────────── Matching Tests ──────────────────────

    function testExactFill() public {
        // Bob places sell at 50e15
        vm.prank(bob);
        dlob.placeLimitOrder(DLOB.Side.Sell, 50e15, 100e6, bytes32(0), bytes32(0), 0, 0);

        // Alice places buy at 50e15 — should match
        uint256 aliceBaseBefore = baseToken.balanceOf(alice);
        uint256 bobQuoteBefore = quoteToken.balanceOf(bob);

        vm.prank(alice);
        dlob.placeLimitOrder(DLOB.Side.Buy, 50e15, 100e6, bytes32(0), bytes32(0), 0, 0);

        // Alice got base tokens
        assertEq(baseToken.balanceOf(alice), aliceBaseBefore + 100e6);
        // Bob got quote tokens (100e6 * 50e15 / 1e18 = 5e6)
        uint128 expectedQuote = uint128((uint256(100e6) * 50e15) / PRECISION);
        assertEq(quoteToken.balanceOf(bob), bobQuoteBefore + expectedQuote);

        // Order book should be empty
        (uint96 bid, uint96 ask) = dlob.getBestPrices();
        assertEq(bid, 0);
        assertEq(ask, 0);
    }

    function testPartialFill() public {
        vm.prank(bob);
        dlob.placeLimitOrder(DLOB.Side.Sell, 50e15, 200e6, bytes32(0), bytes32(0), 0, 0);

        vm.prank(alice);
        dlob.placeLimitOrder(DLOB.Side.Buy, 50e15, 100e6, bytes32(0), bytes32(0), 0, 0);

        // Bob's order should have 100e6 remaining
        DLOB.Order memory bobOrder = dlob.getOrder(1);
        assertEq(bobOrder.remainingAmount, 100e6);

        // Ask should still be at 50e15
        (, uint96 ask) = dlob.getBestPrices();
        assertEq(ask, 50e15);
    }

    function testNoMatchPositiveSpread() public {
        vm.prank(alice);
        dlob.placeLimitOrder(DLOB.Side.Buy, 40e15, 100e6, bytes32(0), bytes32(0), 0, 0);

        vm.prank(bob);
        dlob.placeLimitOrder(DLOB.Side.Sell, 50e15, 100e6, bytes32(0), bytes32(0), 0, 0);

        // Both should rest
        (uint96 bid, uint96 ask) = dlob.getBestPrices();
        assertEq(bid, 40e15);
        assertEq(ask, 50e15);
    }

    function testPriceTimePriority() public {
        // Two sells at the same price
        vm.prank(bob);
        dlob.placeLimitOrder(DLOB.Side.Sell, 50e15, 100e6, bytes32(0), bytes32(0), 0, 0);
        vm.prank(charlie);
        dlob.placeLimitOrder(DLOB.Side.Sell, 50e15, 100e6, bytes32(0), bytes32(0), 0, 0);

        // Buy 100 — should fill Bob first (FIFO)
        uint256 bobQuoteBefore = quoteToken.balanceOf(bob);
        uint256 charlieQuoteBefore = quoteToken.balanceOf(charlie);

        vm.prank(alice);
        dlob.placeLimitOrder(DLOB.Side.Buy, 50e15, 100e6, bytes32(0), bytes32(0), 0, 0);

        uint128 expectedQuote = uint128((uint256(100e6) * 50e15) / PRECISION);
        assertEq(quoteToken.balanceOf(bob), bobQuoteBefore + expectedQuote);
        assertEq(quoteToken.balanceOf(charlie), charlieQuoteBefore); // Charlie untouched
    }

    function testSelfTradeReverts() public {
        vm.prank(alice);
        dlob.placeLimitOrder(DLOB.Side.Sell, 50e15, 100e6, bytes32(0), bytes32(0), 0, 0);

        vm.prank(alice);
        vm.expectRevert(DLOB.SelfTrade.selector);
        dlob.placeLimitOrder(DLOB.Side.Buy, 50e15, 100e6, bytes32(0), bytes32(0), 0, 0);
    }

    function testExpiredOrderSkippedDuringMatching() public {
        vm.warp(1000);

        // Bob places sell that expires at 1500
        vm.prank(bob);
        dlob.placeLimitOrder(DLOB.Side.Sell, 50e15, 100e6, bytes32(0), bytes32(0), 0, 1500);

        // Charlie places sell at same price, no expiry
        vm.prank(charlie);
        dlob.placeLimitOrder(DLOB.Side.Sell, 50e15, 100e6, bytes32(0), bytes32(0), 0, 0);

        // Warp past Bob's expiry
        vm.warp(2000);

        // Alice buys — should skip Bob (expired) and fill against Charlie
        uint256 charlieQuoteBefore = quoteToken.balanceOf(charlie);
        vm.prank(alice);
        dlob.placeLimitOrder(DLOB.Side.Buy, 50e15, 100e6, bytes32(0), bytes32(0), 0, 0);

        uint128 expectedQuote = uint128((uint256(100e6) * 50e15) / PRECISION);
        assertEq(quoteToken.balanceOf(charlie), charlieQuoteBefore + expectedQuote);

        // Bob's order should be cancelled (expired during matching)
        DLOB.Order memory bobOrder = dlob.getOrder(1);
        assertEq(uint8(bobOrder.status), uint8(DLOB.OrderStatus.Cancelled));
    }

    // ──────────────────── View Tests ──────────────────────────

    function testGetSpread() public {
        vm.prank(alice);
        dlob.placeLimitOrder(DLOB.Side.Buy, 40e15, 100e6, bytes32(0), bytes32(0), 0, 0);
        vm.prank(bob);
        dlob.placeLimitOrder(DLOB.Side.Sell, 50e15, 100e6, bytes32(0), bytes32(0), 0, 0);

        assertEq(dlob.getSpread(), 10e15);
    }

    function testGetOrderBook() public {
        vm.prank(alice);
        dlob.placeLimitOrder(DLOB.Side.Buy, 40e15, 100e6, bytes32(0), bytes32(0), 0, 0);
        vm.prank(alice);
        dlob.placeLimitOrder(DLOB.Side.Buy, 30e15, 200e6, bytes32(0), bytes32(0), 0, 0);

        (uint96[] memory prices, uint128[] memory volumes, uint8 count) =
            dlob.getOrderBook(DLOB.Side.Buy, 5);

        assertEq(count, 2);
        assertEq(prices[0], 40e15);
        assertEq(volumes[0], 100e6);
        assertEq(prices[1], 30e15);
        assertEq(volumes[1], 200e6);
    }

    // ──────────────────── Admin Tests ─────────────────────────

    function testSweepOrphanedDot() public {
        // Create market with deposit
        factory.setMarketCreationDeposit(0.1 ether);
        MockERC20 base2 = new MockERC20("B2", "B2");
        MockERC20 quote2 = new MockERC20("Q2", "Q2");
        address dlob2Addr = factory.createMarket{value: 0.1 ether}(
            address(base2), address(quote2), TICK_SIZE, MIN_ORDER_SIZE, MAX_ORDER_SIZE
        );
        DLOB dlob2 = DLOB(payable(dlob2Addr));

        // Sweep the deposit
        uint128 available = uint128(address(dlob2).balance) - dlob2.totalFeeReserveBalance();
        assertEq(available, 0.1 ether);

        address recipient = address(0x1234);
        dlob2.sweepOrphanedDot(recipient, uint128(0.1 ether));
        assertEq(recipient.balance, 0.1 ether);
    }

    function testSweepOrphanedDotNotAdmin() public {
        vm.prank(address(0xBEEF));
        vm.expectRevert(DLOB.NotAdmin.selector);
        dlob.sweepOrphanedDot(address(0x1234), 1);
    }

    // ──────────────────── Depth Integrity Tests ───────────────────

    /// @notice Fuzz test: depth at a price level equals sum of remaining amounts after
    ///         random placements, cancellations, and fills.
    function testFuzzDepthIntegrity(uint8 numOrders, uint8 cancelMask, uint8 fillCount) public {
        uint256 n = bound(numOrders, 2, 20);
        uint96 price = 50e15;
        uint128 orderSize = 10e6;

        address[3] memory senders = [alice, bob, charlie];
        uint32[] memory orderIds = new uint32[](n);

        for (uint256 i = 0; i < n; i++) {
            address sender = senders[i % 3];
            vm.prank(sender);
            orderIds[i] = dlob.placeLimitOrder(
                DLOB.Side.Sell, price, orderSize, bytes32(uint256(i + 100)), bytes32(0), 0, 0
            );
        }

        for (uint256 i = 0; i < n; i++) {
            if (cancelMask & (1 << (i % 8)) != 0) {
                address sender = senders[i % 3];
                vm.prank(sender);
                dlob.cancelOrder(orderIds[i], bytes32(uint256(i + 100)));
            }
        }

        uint256 fillN = bound(fillCount, 0, 5);
        if (fillN > 0) {
            uint128 buyAmount = uint128(fillN * orderSize);
            vm.prank(alice);
            dlob.placeMarketOrder(DLOB.Side.Buy, buyAmount, 0, bytes32(uint256(999)), bytes32(0), 0);
        }

        uint128 depth = dlob.getDepthAtPrice(DLOB.Side.Sell, price);
        uint128 sumRemaining = 0;
        for (uint256 i = 0; i < n; i++) {
            DLOB.Order memory o = dlob.getOrder(orderIds[i]);
            if (o.price == price && uint8(o.status) == uint8(DLOB.OrderStatus.Active)) {
                sumRemaining += o.remainingAmount;
            }
        }
        assertEq(depth, sumRemaining, "Depth must equal sum of remaining amounts");
    }

    /// @notice Deterministic depth test: place, cancel some, fill some, check depth.
    function testDepthIntegrityDeterministic() public {
        uint96 price = 50e15;
        uint128 orderSize = 100e6;

        vm.prank(bob);
        uint32 id1 = dlob.placeLimitOrder(
            DLOB.Side.Sell, price, orderSize, bytes32(uint256(10)), bytes32(0), 0, 0
        );
        vm.prank(bob);
        uint32 id2 = dlob.placeLimitOrder(
            DLOB.Side.Sell, price, orderSize, bytes32(uint256(11)), bytes32(0), 0, 0
        );
        vm.prank(charlie);
        uint32 id3 = dlob.placeLimitOrder(
            DLOB.Side.Sell, price, orderSize, bytes32(uint256(12)), bytes32(0), 0, 0
        );
        vm.prank(charlie);
        uint32 id4 = dlob.placeLimitOrder(
            DLOB.Side.Sell, price, orderSize, bytes32(uint256(13)), bytes32(0), 0, 0
        );
        vm.prank(bob);
        uint32 id5 = dlob.placeLimitOrder(
            DLOB.Side.Sell, price, orderSize, bytes32(uint256(14)), bytes32(0), 0, 0
        );

        assertEq(dlob.getDepthAtPrice(DLOB.Side.Sell, price), 500e6);

        vm.prank(bob);
        dlob.cancelOrder(id2, bytes32(uint256(11)));
        vm.prank(charlie);
        dlob.cancelOrder(id4, bytes32(uint256(13)));

        assertEq(dlob.getDepthAtPrice(DLOB.Side.Sell, price), 300e6);

        vm.prank(alice);
        dlob.placeMarketOrder(DLOB.Side.Buy, 150e6, 0, bytes32(0), bytes32(0), 0);

        assertEq(dlob.getDepthAtPrice(DLOB.Side.Sell, price), 150e6);

        assertEq(dlob.getOrder(id1).remainingAmount, 0);
        assertEq(dlob.getOrder(id3).remainingAmount, 50e6);
        assertEq(dlob.getOrder(id5).remainingAmount, 100e6);
    }
}
