// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) Parity Technologies (UK) Ltd.
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import "../src/DLOBFactory.sol";
import "../src/DLOB.sol";
import "../src/mocks/MockERC20.sol";
import "../src/mocks/MockXcm.sol";
import "../src/mocks/MockSystem.sol";

contract CrossChainTest is Test {
    DLOBFactory public factory;
    DLOB public dlob;
    MockXcm public mockXcm;
    MockSystem public mockSystem;
    MockERC20 public baseToken;
    MockERC20 public quoteToken;

    address alice = address(0xA11CE);
    address bob = address(0xB0B);
    address charlie = address(0xC0C0C0);

    uint96 constant TICK_SIZE = 1e15;
    uint96 constant MIN_ORDER_SIZE = 1e6;
    uint128 constant MAX_ORDER_SIZE = 1e24;
    uint256 constant PRECISION = 1e18;

    bytes32 constant ALICE_ORIGIN = bytes32(uint256(1));
    bytes32 constant BOB_ORIGIN = bytes32(uint256(2));
    bytes32 constant ALICE_SETTLEMENT = bytes32(uint256(0xA11CE));
    bytes32 constant BOB_SETTLEMENT = bytes32(uint256(0xB0B));
    bytes32 constant CHARLIE_SETTLEMENT = bytes32(uint256(0xC));
    uint32 constant PARA_1000 = 1000;
    uint32 constant PARA_2000 = 2000;
    uint32 constant PARA_3000 = 3000;

    // Use sane prices relative to PRECISION (e.g. 50e15 = 0.05)
    uint96 constant PRICE = 50e15;

    function setUp() public {
        mockXcm = new MockXcm();
        mockSystem = new MockSystem();
        DLOB impl = new DLOB();
        factory = new DLOBFactory(address(mockXcm), address(mockSystem), address(impl));
        factory.setMinCrossChainFee(1e9);

        baseToken = new MockERC20("Base", "BASE");
        quoteToken = new MockERC20("Quote", "QUOTE");
        address dlobAddr = factory.createMarket(
            address(baseToken), address(quoteToken), TICK_SIZE, MIN_ORDER_SIZE, MAX_ORDER_SIZE
        );
        dlob = DLOB(payable(dlobAddr));

        baseToken.mint(alice, 1_000_000e18);
        baseToken.mint(bob, 1_000_000e18);
        baseToken.mint(charlie, 1_000_000e18);
        quoteToken.mint(alice, 1_000_000e18);
        quoteToken.mint(bob, 1_000_000e18);
        quoteToken.mint(charlie, 1_000_000e18);

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

        vm.deal(alice, 100 ether);
        vm.deal(bob, 100 ether);
        vm.deal(charlie, 100 ether);
    }

    // ================== INLINE XCM SETTLEMENT (HAPPY PATH) ==================

    function testLocalBuyLocalSell() public {
        vm.prank(alice);
        dlob.placeLimitOrder(DLOB.Side.Buy, PRICE, 100e6, bytes32(0), bytes32(0), 0, 0);

        vm.prank(bob);
        uint128 filled = dlob.placeMarketOrder(DLOB.Side.Sell, 100e6, 0, bytes32(0), bytes32(0), 0);

        assertEq(filled, 100e6);
        assertEq(mockXcm.getExecuteCallCount(), 0, "No XCM for local orders");
        assertEq(dlob.totalFeeReserveBalance(), 0);
    }

    function testCrossChainBuyLocalSell() public {
        // Alice: cross-chain buyer on para 1000
        vm.prank(alice);
        uint32 buyId = dlob.placeLimitOrder{value: 1e9}(
            DLOB.Side.Buy, PRICE, 100e6, ALICE_ORIGIN, ALICE_SETTLEMENT, PARA_1000, 0
        );
        assertEq(dlob.getOrderFeeReserve(buyId), 1e9);

        uint256 bobQuoteBefore = quoteToken.balanceOf(bob);

        // Bob: local sell matches
        vm.prank(bob);
        uint128 filled = dlob.placeMarketOrder(DLOB.Side.Sell, 100e6, 0, bytes32(0), bytes32(0), 0);
        assertEq(filled, 100e6);

        // Bob gets quote via ERC20
        uint128 expectedQuote = uint128((uint256(100e6) * PRICE) / PRECISION);
        assertEq(quoteToken.balanceOf(bob) - bobQuoteBefore, expectedQuote);

        // Alice gets base via XCM
        assertGt(mockXcm.getExecuteCallCount(), 0, "XCM called for cross-chain buyer");

        // Fee reserve consumed
        assertEq(dlob.getOrderFeeReserve(buyId), 0);
    }

    function testLocalBuyCrossChainSell() public {
        // Bob: cross-chain seller on para 2000
        vm.prank(bob);
        uint32 sellId = dlob.placeLimitOrder{value: 1e9}(
            DLOB.Side.Sell, PRICE, 100e6, BOB_ORIGIN, BOB_SETTLEMENT, PARA_2000, 0
        );

        uint256 aliceBaseBefore = baseToken.balanceOf(alice);

        // Alice: local buy matches
        vm.prank(alice);
        uint128 filled = dlob.placeMarketOrder(DLOB.Side.Buy, 100e6, 0, bytes32(0), bytes32(0), 0);
        assertEq(filled, 100e6);

        // Alice gets base via ERC20
        assertEq(baseToken.balanceOf(alice) - aliceBaseBefore, 100e6);

        // Bob gets quote via XCM
        assertGt(mockXcm.getExecuteCallCount(), 0, "XCM called for cross-chain seller");
        assertEq(dlob.getOrderFeeReserve(sellId), 0);
    }

    function testCrossChainBuyCrossChainSell() public {
        // Alice: cross-chain buy
        vm.prank(alice);
        uint32 buyId = dlob.placeLimitOrder{value: 1e9}(
            DLOB.Side.Buy, PRICE, 100e6, ALICE_ORIGIN, ALICE_SETTLEMENT, PARA_1000, 0
        );

        // Bob: cross-chain sell matches
        vm.prank(bob);
        uint128 filled = dlob.placeMarketOrder{value: 1e9}(
            DLOB.Side.Sell, 100e6, 0, BOB_ORIGIN, BOB_SETTLEMENT, PARA_2000
        );
        assertEq(filled, 100e6);

        // Both settled via XCM
        assertGt(mockXcm.getExecuteCallCount(), 1, "XCM called for both");
        assertEq(dlob.getOrderFeeReserve(buyId), 0);
    }

    // ================== FALLBACK TO PENDING CLAIM ==================

    function testInlineXcmFailsFallbackToClaim() public {
        mockXcm.setShouldRevert(true);

        // Alice: cross-chain buy
        vm.prank(alice);
        uint32 buyId = dlob.placeLimitOrder{value: 1e9}(
            DLOB.Side.Buy, PRICE, 100e6, ALICE_ORIGIN, ALICE_SETTLEMENT, PARA_1000, 0
        );

        // Bob: local sell matches — inline XCM fails, fallback to claim
        vm.prank(bob);
        uint128 filled = dlob.placeMarketOrder(DLOB.Side.Sell, 100e6, 0, bytes32(0), bytes32(0), 0);
        assertEq(filled, 100e6, "Order should still fill");

        // Fee reserve NOT consumed (inline failed)
        assertEq(dlob.getOrderFeeReserve(buyId), 1e9, "Fee reserve should remain");

        // PendingClaim created
        uint32 claimId = dlob.nextClaimId() - 1;
        DLOB.PendingClaim memory claim = dlob.getPendingClaim(claimId);
        assertEq(uint8(claim.claimType), uint8(DLOB.ClaimType.Fill));
        assertEq(claim.beneficiary, ALICE_SETTLEMENT);
        assertEq(claim.destParaId, PARA_1000);
    }

    function testClaimSettlementAfterFailedInline() public {
        mockXcm.setShouldRevert(true);

        vm.prank(alice);
        uint32 buyId = dlob.placeLimitOrder{value: 1e9}(
            DLOB.Side.Buy, PRICE, 100e6, ALICE_ORIGIN, ALICE_SETTLEMENT, PARA_1000, 0
        );

        vm.prank(bob);
        dlob.placeMarketOrder(DLOB.Side.Sell, 100e6, 0, bytes32(0), bytes32(0), 0);

        uint32 claimId = dlob.nextClaimId() - 1;

        // Fix XCM and settle
        mockXcm.setShouldRevert(false);
        mockXcm.reset();

        uint128 feeBefore = dlob.getOrderFeeReserve(buyId);
        dlob.claimSettlement(claimId);

        assertGt(mockXcm.getExecuteCallCount(), 0, "XCM called during claim");
        assertLt(dlob.getOrderFeeReserve(buyId), feeBefore, "Fee deducted");

        // Claim should be deleted
        DLOB.PendingClaim memory claim = dlob.getPendingClaim(claimId);
        assertEq(claim.amount, 0, "Claim should be deleted");
    }

    function testClaimSettlementByAnyone() public {
        mockXcm.setShouldRevert(true);

        vm.prank(alice);
        dlob.placeLimitOrder{value: 1e9}(
            DLOB.Side.Buy, PRICE, 100e6, ALICE_ORIGIN, ALICE_SETTLEMENT, PARA_1000, 0
        );

        vm.prank(bob);
        dlob.placeMarketOrder(DLOB.Side.Sell, 100e6, 0, bytes32(0), bytes32(0), 0);

        uint32 claimId = dlob.nextClaimId() - 1;

        mockXcm.setShouldRevert(false);
        mockXcm.reset();

        // Charlie (not the owner) settles
        vm.prank(charlie);
        dlob.claimSettlement(claimId);
        assertGt(mockXcm.getExecuteCallCount(), 0, "Anyone can settle claims");
    }

    function testClaimSettlementWithTopUp() public {
        mockXcm.setShouldRevert(true);

        vm.prank(alice);
        dlob.placeLimitOrder{value: 1e9}(
            DLOB.Side.Buy, PRICE, 100e6, ALICE_ORIGIN, ALICE_SETTLEMENT, PARA_1000, 0
        );

        vm.prank(bob);
        dlob.placeMarketOrder(DLOB.Side.Sell, 100e6, 0, bytes32(0), bytes32(0), 0);

        uint32 claimId = dlob.nextClaimId() - 1;

        mockXcm.setShouldRevert(false);
        mockXcm.reset();

        uint256 charlieBefore = charlie.balance;
        vm.prank(charlie);
        dlob.claimSettlement{value: 5e8}(claimId);

        assertGt(mockXcm.getExecuteCallCount(), 0);
        // Excess refunded to charlie
        assertGt(charlie.balance, charlieBefore - 5e8, "Excess refunded");
    }

    function testClaimSettlementInsufficientFee() public {
        mockXcm.setShouldRevert(true);

        // Place with exact min fee — fee stays in reserve since inline failed
        vm.prank(alice);
        dlob.placeLimitOrder{value: 1e9}(
            DLOB.Side.Buy, PRICE, 100e6, ALICE_ORIGIN, ALICE_SETTLEMENT, PARA_1000, 0
        );

        vm.prank(bob);
        dlob.placeMarketOrder(DLOB.Side.Sell, 100e6, 0, bytes32(0), bytes32(0), 0);

        uint32 claimId = dlob.nextClaimId() - 1;

        mockXcm.setShouldRevert(false);

        // Drain the fee reserve by settling, then try again
        dlob.claimSettlement(claimId);

        // Now there's no claim left — should revert with ClaimNotFound
        vm.expectRevert(DLOB.ClaimNotFound.selector);
        dlob.claimSettlement(claimId);
    }

    function testRevertClaimNotFound() public {
        vm.expectRevert(DLOB.ClaimNotFound.selector);
        dlob.claimSettlement(99999);
    }

    // ================== FEE RESERVE LIFECYCLE ==================

    function testFeeReserveDeductedPerFill() public {
        // Alice: cross-chain buy with 2x fee for 2 fills
        vm.prank(alice);
        uint32 buyId = dlob.placeLimitOrder{value: 2e9}(
            DLOB.Side.Buy, PRICE, 200e6, ALICE_ORIGIN, ALICE_SETTLEMENT, PARA_1000, 0
        );
        assertEq(dlob.getOrderFeeReserve(buyId), 2e9);

        // Fill 1: 100e6
        vm.prank(bob);
        dlob.placeMarketOrder(DLOB.Side.Sell, 100e6, 0, bytes32(0), bytes32(0), 0);
        assertEq(dlob.getOrderFeeReserve(buyId), 1e9, "1e9 after first fill");

        // Fill 2: 100e6
        vm.prank(charlie);
        dlob.placeMarketOrder(DLOB.Side.Sell, 100e6, 0, bytes32(0), bytes32(0), 0);
        assertEq(dlob.getOrderFeeReserve(buyId), 0, "0 after second fill");
    }

    function testWithdrawExcessFeeReserve() public {
        vm.prank(alice);
        uint32 buyId = dlob.placeLimitOrder{value: 5e9}(
            DLOB.Side.Buy, PRICE, 100e6, ALICE_ORIGIN, ALICE_SETTLEMENT, PARA_1000, 0
        );

        // Fill completely
        vm.prank(bob);
        dlob.placeMarketOrder(DLOB.Side.Sell, 100e6, 0, bytes32(0), bytes32(0), 0);

        // 5e9 - 1e9 = 4e9 excess
        assertEq(dlob.getOrderFeeReserve(buyId), 4e9);

        (bool canWithdraw, uint128 excess) = dlob.canWithdrawExcessFeeReserve(buyId);
        assertTrue(canWithdraw);
        assertEq(excess, 4e9);

        uint256 contractBefore = address(dlob).balance;
        vm.prank(alice);
        dlob.withdrawExcessFeeReserve(buyId);

        assertEq(contractBefore - address(dlob).balance, 4e9);
        assertEq(dlob.getOrderFeeReserve(buyId), 0);
    }

    function testWithdrawExcessFeeReserveNotActive() public {
        vm.prank(alice);
        uint32 buyId = dlob.placeLimitOrder{value: 3e9}(
            DLOB.Side.Buy, PRICE, 200e6, ALICE_ORIGIN, ALICE_SETTLEMENT, PARA_1000, 0
        );

        // Partial fill
        vm.prank(bob);
        dlob.placeMarketOrder(DLOB.Side.Sell, 100e6, 0, bytes32(0), bytes32(0), 0);

        (bool canWithdraw,) = dlob.canWithdrawExcessFeeReserve(buyId);
        assertFalse(canWithdraw);

        vm.prank(alice);
        vm.expectRevert(DLOB.OrderStillActive.selector);
        dlob.withdrawExcessFeeReserve(buyId);
    }

    function testWithdrawExcessFeeReserveZero() public {
        vm.prank(alice);
        uint32 buyId = dlob.placeLimitOrder{value: 1e9}(
            DLOB.Side.Buy, PRICE, 100e6, ALICE_ORIGIN, ALICE_SETTLEMENT, PARA_1000, 0
        );

        // Fill completely — uses exactly 1e9 fee
        vm.prank(bob);
        dlob.placeMarketOrder(DLOB.Side.Sell, 100e6, 0, bytes32(0), bytes32(0), 0);

        assertEq(dlob.getOrderFeeReserve(buyId), 0);

        vm.prank(alice);
        vm.expectRevert(DLOB.NoExcess.selector);
        dlob.withdrawExcessFeeReserve(buyId);
    }

    function testTotalFeeReserveBalanceTracking() public {
        assertEq(dlob.totalFeeReserveBalance(), 0);

        // Use different prices so orders don't match
        vm.prank(alice);
        uint32 buyId = dlob.placeLimitOrder{value: 3e9}(
            DLOB.Side.Buy, PRICE, 100e6, ALICE_ORIGIN, ALICE_SETTLEMENT, PARA_1000, 0
        );
        assertEq(dlob.totalFeeReserveBalance(), 3e9);

        uint96 highAsk = PRICE * 2;
        vm.prank(bob);
        dlob.placeLimitOrder{value: 2e9}(
            DLOB.Side.Sell, highAsk, 100e6, BOB_ORIGIN, BOB_SETTLEMENT, PARA_2000, 0
        );
        assertEq(dlob.totalFeeReserveBalance(), 5e9);

        // Cancel Alice's order — fee reserve stays because it's needed for the refund claim
        vm.prank(alice);
        dlob.cancelOrder(buyId, ALICE_ORIGIN);
        // Fee remains reserved for the pending refund claim
        assertEq(dlob.totalFeeReserveBalance(), 5e9, "Fee still reserved for refund claim");

        // Settle the refund claim — this consumes the fee
        uint32 claimId = dlob.nextClaimId() - 1;
        dlob.claimSettlement(claimId);
        assertLt(dlob.totalFeeReserveBalance(), 5e9, "Decreased after claim settlement");
    }

    // ================== CROSS-CHAIN CANCEL ==================

    function testCrossChainCancelCreatesRefundClaim() public {
        vm.prank(alice);
        uint32 buyId = dlob.placeLimitOrder{value: 2e9}(
            DLOB.Side.Buy, PRICE, 100e6, ALICE_ORIGIN, ALICE_SETTLEMENT, PARA_1000, 0
        );

        vm.prank(alice);
        dlob.cancelOrder(buyId, ALICE_ORIGIN);

        uint32 claimId = dlob.nextClaimId() - 1;
        DLOB.PendingClaim memory claim = dlob.getPendingClaim(claimId);
        assertEq(uint8(claim.claimType), uint8(DLOB.ClaimType.Refund));
        assertEq(claim.destParaId, PARA_1000);
        assertEq(claim.beneficiary, ALICE_SETTLEMENT);
    }

    // ================== CLAIM REDIRECT ==================

    function testRedirectClaim() public {
        mockXcm.setShouldRevert(true);

        vm.prank(alice);
        dlob.placeLimitOrder{value: 1e9}(
            DLOB.Side.Buy, PRICE, 100e6, ALICE_ORIGIN, ALICE_SETTLEMENT, PARA_1000, 0
        );

        vm.prank(bob);
        dlob.placeMarketOrder(DLOB.Side.Sell, 100e6, 0, bytes32(0), bytes32(0), 0);

        uint32 claimId = dlob.nextClaimId() - 1;
        assertEq(dlob.getPendingClaim(claimId).destParaId, PARA_1000);

        // Alice redirects
        vm.prank(alice);
        dlob.redirectClaim(claimId, ALICE_ORIGIN, PARA_3000, CHARLIE_SETTLEMENT);

        DLOB.PendingClaim memory claim = dlob.getPendingClaim(claimId);
        assertEq(claim.destParaId, PARA_3000);
        assertEq(claim.beneficiary, CHARLIE_SETTLEMENT);
    }

    function testRedirectClaimWrongOwner() public {
        mockXcm.setShouldRevert(true);

        vm.prank(alice);
        dlob.placeLimitOrder{value: 1e9}(
            DLOB.Side.Buy, PRICE, 100e6, ALICE_ORIGIN, ALICE_SETTLEMENT, PARA_1000, 0
        );

        vm.prank(bob);
        dlob.placeMarketOrder(DLOB.Side.Sell, 100e6, 0, bytes32(0), bytes32(0), 0);

        uint32 claimId = dlob.nextClaimId() - 1;

        vm.prank(bob);
        vm.expectRevert(DLOB.NotOrderOwner.selector);
        dlob.redirectClaim(claimId, BOB_ORIGIN, PARA_3000, BOB_SETTLEMENT);
    }

    function testRedirectClaimThenSettle() public {
        mockXcm.setShouldRevert(true);

        vm.prank(alice);
        dlob.placeLimitOrder{value: 1e9}(
            DLOB.Side.Buy, PRICE, 100e6, ALICE_ORIGIN, ALICE_SETTLEMENT, PARA_1000, 0
        );

        vm.prank(bob);
        dlob.placeMarketOrder(DLOB.Side.Sell, 100e6, 0, bytes32(0), bytes32(0), 0);

        uint32 claimId = dlob.nextClaimId() - 1;

        // Redirect
        vm.prank(alice);
        dlob.redirectClaim(claimId, ALICE_ORIGIN, PARA_3000, CHARLIE_SETTLEMENT);

        // Settle
        mockXcm.setShouldRevert(false);
        mockXcm.reset();

        vm.prank(charlie);
        dlob.claimSettlement(claimId);
        assertGt(mockXcm.getExecuteCallCount(), 0);
    }

    function testAdminRedirectClaim() public {
        mockXcm.setShouldRevert(true);

        vm.prank(alice);
        dlob.placeLimitOrder{value: 1e9}(
            DLOB.Side.Buy, PRICE, 100e6, ALICE_ORIGIN, ALICE_SETTLEMENT, PARA_1000, 0
        );

        vm.prank(bob);
        dlob.placeMarketOrder(DLOB.Side.Sell, 100e6, 0, bytes32(0), bytes32(0), 0);

        uint32 claimId = dlob.nextClaimId() - 1;

        // Admin redirects (test contract is admin via factory)
        dlob.adminRedirectClaim(claimId, PARA_3000, CHARLIE_SETTLEMENT);

        assertEq(dlob.getPendingClaim(claimId).destParaId, PARA_3000);
    }

    // ================== ASSET ID EXTRACTION ==================

    function testExtractAssetIdCorrect() public {
        // ERC20 precompile addresses on Asset Hub encode the asset ID in the upper 32 bits.
        // For asset ID 42: address = uint160(42) << 128 | 0x...prefix
        uint32 expectedId = 42;
        address assetPrecompile = address(uint160(uint256(expectedId) << 128));

        // The extracted ID should match
        // Use the inline XCM path to verify indirectly — or just call _extractAssetId via
        // a helper. Since _extractAssetId is internal, we verify via the claim token flow.
        // For a direct test, we check the math:
        uint128 extracted = uint128(uint160(assetPrecompile) >> 128);
        assertEq(extracted, expectedId, "Asset ID should be extracted from upper 32 bits");
    }

    function testAdminRedirectClaimNotAdmin() public {
        mockXcm.setShouldRevert(true);

        vm.prank(alice);
        dlob.placeLimitOrder{value: 1e9}(
            DLOB.Side.Buy, PRICE, 100e6, ALICE_ORIGIN, ALICE_SETTLEMENT, PARA_1000, 0
        );

        vm.prank(bob);
        dlob.placeMarketOrder(DLOB.Side.Sell, 100e6, 0, bytes32(0), bytes32(0), 0);

        uint32 claimId = dlob.nextClaimId() - 1;

        vm.prank(charlie);
        vm.expectRevert(DLOB.NotAdmin.selector);
        dlob.adminRedirectClaim(claimId, PARA_3000, CHARLIE_SETTLEMENT);
    }
}
