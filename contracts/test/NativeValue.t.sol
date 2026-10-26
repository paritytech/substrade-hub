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
import {XcmBuilder} from "../src/libraries/XcmBuilder.sol";

/// @notice The fee reserve and the factory's fee and deposit count in planck, while `msg.value` and
/// native transfers count in 18-decimal units. These tests use the ratio of a 10-decimal chain, as on
/// Polkadot and Paseo, where one planck is 10^8 of those units.
contract NativeValueTest is Test {
    DLOBFactory public factory;
    DLOB public dlob;
    MockXcm public mockXcm;
    MockSystem public mockSystem;
    MockERC20 public baseToken;
    MockERC20 public quoteToken;

    address alice = address(0xA11CE);
    address bob = address(0xB0B);

    uint96 constant RATIO = 1e8;
    uint128 constant FEE = 1e9; // planck: 0.1 DOT
    uint256 constant FEE_VALUE = uint256(FEE) * RATIO; // the same fee as msg.value

    uint96 constant TICK_SIZE = 1e15;
    uint96 constant MIN_ORDER_SIZE = 1e6;
    uint128 constant MAX_ORDER_SIZE = 1e24;
    uint96 constant PRICE = 50e15;
    bytes32 constant ALICE_ORIGIN = bytes32(uint256(1));
    bytes32 constant ALICE_SETTLEMENT = bytes32(uint256(0xA11CE));
    uint32 constant PARA_1000 = 1000;

    function setUp() public {
        mockXcm = new MockXcm();
        mockSystem = new MockSystem();
        factory = new DLOBFactory(address(mockXcm), address(mockSystem), address(new DLOB()), RATIO);
        factory.setMinCrossChainFee(FEE);

        baseToken = new MockERC20("Base", "BASE");
        quoteToken = new MockERC20("Quote", "QUOTE");
        dlob = DLOB(payable(_createMarket(baseToken, quoteToken, 0)));

        for (uint256 i = 0; i < 2; i++) {
            address a = i == 0 ? alice : bob;
            baseToken.mint(a, 1_000_000e18);
            quoteToken.mint(a, 1_000_000e18);
            vm.startPrank(a);
            baseToken.approve(address(dlob), type(uint256).max);
            quoteToken.approve(address(dlob), type(uint256).max);
            vm.stopPrank();
            vm.deal(a, 100 ether);
        }
    }

    function _createMarket(MockERC20 base, MockERC20 quote, uint256 value)
        internal
        returns (address)
    {
        return factory.createMarket{value: value}(
            TokenConfig(address(base), ""),
            TokenConfig(address(quote), ""),
            TICK_SIZE,
            MIN_ORDER_SIZE,
            MAX_ORDER_SIZE
        );
    }

    /// Alice rests a cross-chain buy of 100 base, sending `value` as its fee reserve.
    function _crossChainBuy(uint256 value) internal returns (uint32 orderId) {
        vm.prank(alice);
        (orderId,) = dlob.placeLimitOrder{value: value}(
            DLOB.Side.Buy, PRICE, 100e6, ALICE_ORIGIN, ALICE_SETTLEMENT, PARA_1000, 0, false
        );
    }

    /// Bob sells `amount` base into the book, locally.
    function _localSell(uint128 amount) internal {
        vm.prank(bob);
        dlob.placeMarketOrder(DLOB.Side.Sell, amount, 0, 0, bytes32(0), bytes32(0), 0);
    }

    // ================== FACTORY ==================

    function testInvalidRatioIsRefused() public {
        address impl = address(new DLOB());
        vm.expectRevert(DLOBFactory.InvalidRatio.selector);
        new DLOBFactory(address(mockXcm), address(mockSystem), impl, 0);
        vm.expectRevert(DLOBFactory.InvalidRatio.selector);
        new DLOBFactory(address(mockXcm), address(mockSystem), impl, 1e18 + 1);
    }

    /// The caps are 10 and 1,000 of the native token, whatever its decimals.
    function testCapsFollowTheNativeDecimals() public {
        assertEq(factory.MAX_MIN_CROSS_CHAIN_FEE(), 10 * 1e10); // 10 DOT, 10 decimals
        assertEq(factory.MAX_MARKET_CREATION_DEPOSIT(), 1000 * 1e10);

        address impl = address(new DLOB());
        DLOBFactory twelve = new DLOBFactory(address(mockXcm), address(mockSystem), impl, 1e6);
        assertEq(twelve.MAX_MIN_CROSS_CHAIN_FEE(), 10 * 1e12); // 10 KSM or WND, 12 decimals
        assertEq(twelve.MAX_MARKET_CREATION_DEPOSIT(), 1000 * 1e12);
    }

    function testFeeOfOnePlanckIsRefused() public {
        vm.expectRevert(DLOBFactory.FeeTooLow.selector);
        factory.setMinCrossChainFee(1);

        factory.setMinCrossChainFee(2);
        assertEq(factory.minCrossChainFee(), 2);
        factory.setMinCrossChainFee(0);
        assertEq(factory.minCrossChainFee(), 0);
    }

    function testCreationDepositIsInPlanck() public {
        factory.setMarketCreationDeposit(1e10); // 1 DOT
        MockERC20 other = new MockERC20("Other", "OTH");

        vm.expectRevert(DLOBFactory.InsufficientDeposit.selector);
        _createMarket(other, quoteToken, 1e10 * uint256(RATIO) - 1);

        address market = _createMarket(other, quoteToken, 1e10 * uint256(RATIO));
        assertEq(market.balance, 1e10 * uint256(RATIO));
    }

    // ================== PLACING AN ORDER ==================

    function testCrossChainOrdersAreDisabledWithoutAFee() public {
        factory.setMinCrossChainFee(0);
        vm.prank(alice);
        vm.expectRevert(DLOB.CrossChainDisabled.selector);
        dlob.placeLimitOrder{value: FEE_VALUE}(
            DLOB.Side.Buy, PRICE, 100e6, ALICE_ORIGIN, ALICE_SETTLEMENT, PARA_1000, 0, false
        );
    }

    function testReserveIsRecordedInPlanck() public {
        uint32 orderId = _crossChainBuy(3 * FEE_VALUE);
        assertEq(dlob.getOrderFeeReserve(orderId), 3 * FEE);
        assertEq(dlob.totalFeeReserveBalance(), 3 * FEE);
        assertEq(address(dlob).balance, 3 * FEE_VALUE);
    }

    function testValueBelowTheFeeInPlanckReverts() public {
        vm.prank(alice);
        vm.expectRevert(DLOB.InsufficientFeeReserve.selector);
        dlob.placeLimitOrder{value: FEE_VALUE - 1}(
            DLOB.Side.Buy, PRICE, 100e6, ALICE_ORIGIN, ALICE_SETTLEMENT, PARA_1000, 0, false
        );

        // The fee itself, sent as if it were in 18-decimal units, is 10^8 times too little.
        vm.prank(alice);
        vm.expectRevert(DLOB.InsufficientFeeReserve.selector);
        dlob.placeLimitOrder{value: FEE}(
            DLOB.Side.Buy, PRICE, 100e6, ALICE_ORIGIN, ALICE_SETTLEMENT, PARA_1000, 0, false
        );
    }

    function testMarketOrderReturnsItsUnusedReserve() public {
        vm.prank(alice);
        dlob.placeMarketOrder{value: 2 * FEE_VALUE}(
            DLOB.Side.Buy, 100e6, PRICE, 0, ALICE_ORIGIN, ALICE_SETTLEMENT, PARA_1000
        );
        assertEq(address(dlob).balance, 0, "nothing filled, the whole reserve went back");
        assertEq(dlob.totalFeeReserveBalance(), 0);
    }

    // ================== SETTLEMENT ==================

    function testSettlementTakesOneFeeInPlanck() public {
        uint32 orderId = _crossChainBuy(2 * FEE_VALUE);
        _localSell(100e6);

        assertEq(mockXcm.getExecuteCallCount(), 1);
        assertEq(dlob.getOrderFeeReserve(orderId), FEE);
        assertEq(dlob.totalFeeReserveBalance(), FEE);
    }

    function testWithdrawExcessSendsTheReserveInEvmUnits() public {
        uint32 orderId = _crossChainBuy(3 * FEE_VALUE);
        _localSell(100e6);

        uint256 before = address(dlob).balance;
        vm.prank(alice);
        dlob.withdrawExcessFeeReserve(orderId);
        assertEq(before - address(dlob).balance, 2 * FEE_VALUE);
        assertEq(dlob.getOrderFeeReserve(orderId), 0);
    }

    function testRefusedWeighFallsBackToAClaim() public {
        uint32 orderId = _crossChainBuy(FEE_VALUE);
        mockXcm.setWeighShouldRevert(true);

        uint32 claimId = dlob.nextClaimId();
        _localSell(100e6);

        assertEq(dlob.nextClaimId(), claimId + 1, "the fill left a claim");
        assertEq(dlob.getPendingClaim(claimId).orderId, orderId);
        assertEq(dlob.getOrderFeeReserve(orderId), FEE, "the reserve is restored");
        assertEq(mockXcm.getExecuteCallCount(), 0);
    }

    // ================== CLAIMS ==================

    function testFillClaimTakesTheFeeFromValueInPlanck() public {
        uint32 orderId = _crossChainBuy(FEE_VALUE);
        _localSell(50e6); // settles, spending the whole reserve
        uint32 claimId = dlob.nextClaimId();
        _localSell(50e6); // no reserve left: a claim
        assertEq(dlob.getOrderFeeReserve(orderId), 0);

        vm.prank(alice);
        vm.expectRevert(DLOB.InsufficientClaimFee.selector);
        dlob.claimSettlement{value: FEE_VALUE - 1}(claimId);

        uint256 before = address(dlob).balance;
        vm.prank(alice);
        dlob.claimSettlement{value: 2 * FEE_VALUE}(claimId);
        assertEq(address(dlob).balance - before, FEE_VALUE, "one fee kept, the rest returned");
    }

    function testRefundClaimSendsTheReserveInPlanck() public {
        uint32 orderId = _crossChainBuy(FEE_VALUE);
        uint32 claimId = dlob.nextClaimId();
        vm.prank(alice);
        dlob.cancelOrder(orderId, ALICE_ORIGIN);

        DLOB.PendingClaim memory claim = dlob.getPendingClaim(claimId);
        dlob.claimSettlement(claimId);

        (bytes memory message,) = mockXcm.getExecuteCall(mockXcm.getExecuteCallCount() - 1);
        bytes memory expected = XcmBuilder.buildDualAssetReserveTransfer(
            FEE,
            XcmBuilder.locationFromPalletAsset(address(quoteToken)),
            claim.amount,
            PARA_1000,
            ALICE_SETTLEMENT
        );
        assertEq(message, expected, "the refund sends the reserve in planck");
        assertEq(dlob.totalFeeReserveBalance(), 0);
    }

    // ================== ADMIN ==================

    function testSweepCountsInPlanck() public {
        _crossChainBuy(FEE_VALUE);
        vm.deal(address(dlob), FEE_VALUE + 7 * uint256(RATIO) + 5); // 7 planck and some dust, unreserved

        address recipient = address(0xFEE);
        vm.expectRevert(DLOB.ExceedsAvailable.selector);
        dlob.sweepOrphanedDot(recipient, 8);

        dlob.sweepOrphanedDot(recipient, 7);
        assertEq(recipient.balance, 7 * uint256(RATIO));
    }
}
