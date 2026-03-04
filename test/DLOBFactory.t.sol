// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) Parity Technologies (UK) Ltd.
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import "../src/DLOBFactory.sol";
import "../src/DLOB.sol";
import "../src/mocks/MockERC20.sol";
import "../src/mocks/MockXcm.sol";
import "../src/mocks/MockSystem.sol";

contract DLOBFactoryTest is Test {
    DLOBFactory public factory;
    MockXcm public mockXcm;
    MockSystem public mockSystem;
    MockERC20 public baseToken;
    MockERC20 public quoteToken;

    address admin = address(this);
    uint96 constant TICK_SIZE = 1e15; // 0.001 in PRECISION units
    uint96 constant MIN_ORDER_SIZE = 1e6;
    uint128 constant MAX_ORDER_SIZE = 1e24;

    function setUp() public {
        mockXcm = new MockXcm();
        mockSystem = new MockSystem();
        DLOB impl = new DLOB();
        factory = new DLOBFactory(address(mockXcm), address(mockSystem), address(impl));
        baseToken = new MockERC20("Base Token", "BASE");
        quoteToken = new MockERC20("Quote Token", "QUOTE");
    }

    function testCreateMarket() public {
        address dlob = factory.createMarket(
            address(baseToken), address(quoteToken), TICK_SIZE, MIN_ORDER_SIZE, MAX_ORDER_SIZE
        );
        assertTrue(dlob != address(0));
        assertEq(factory.getMarketCount(), 1);
        assertEq(factory.getMarket(address(baseToken), address(quoteToken)), dlob);
    }

    function testCreateDuplicateMarketReverts() public {
        factory.createMarket(
            address(baseToken), address(quoteToken), TICK_SIZE, MIN_ORDER_SIZE, MAX_ORDER_SIZE
        );
        vm.expectRevert(DLOBFactory.MarketExists.selector);
        factory.createMarket(
            address(baseToken), address(quoteToken), TICK_SIZE, MIN_ORDER_SIZE, MAX_ORDER_SIZE
        );
    }

    function testGetMarket() public {
        address dlob = factory.createMarket(
            address(baseToken), address(quoteToken), TICK_SIZE, MIN_ORDER_SIZE, MAX_ORDER_SIZE
        );
        assertEq(factory.getMarket(address(baseToken), address(quoteToken)), dlob);
        // With normalized keys, reverse lookup also works
        assertEq(factory.getMarket(address(quoteToken), address(baseToken)), dlob);
    }

    function testSetMinCrossChainFee() public {
        factory.setMinCrossChainFee(1_000_000_000);
        assertEq(factory.minCrossChainFee(), 1_000_000_000);
    }

    function testSetMinCrossChainFeeNotAdmin() public {
        vm.prank(address(0xBEEF));
        vm.expectRevert(DLOBFactory.NotAdmin.selector);
        factory.setMinCrossChainFee(1_000_000_000);
    }

    function testSetMarketCreationDeposit() public {
        factory.setMarketCreationDeposit(1 ether);
        assertEq(factory.marketCreationDeposit(), 1 ether);
    }

    function testCreateMarketWithDeposit() public {
        factory.setMarketCreationDeposit(0.1 ether);

        address dlob = factory.createMarket{value: 0.1 ether}(
            address(baseToken), address(quoteToken), TICK_SIZE, MIN_ORDER_SIZE, MAX_ORDER_SIZE
        );
        assertEq(address(dlob).balance, 0.1 ether);
    }

    function testCreateMarketInsufficientDeposit() public {
        factory.setMarketCreationDeposit(0.1 ether);

        vm.expectRevert(DLOBFactory.InsufficientDeposit.selector);
        factory.createMarket{value: 0.05 ether}(
            address(baseToken), address(quoteToken), TICK_SIZE, MIN_ORDER_SIZE, MAX_ORDER_SIZE
        );
    }

    function testCreateMarketSameTokenReverts() public {
        vm.expectRevert(DLOBFactory.SameToken.selector);
        factory.createMarket(
            address(baseToken), address(baseToken), TICK_SIZE, MIN_ORDER_SIZE, MAX_ORDER_SIZE
        );
    }

    function testGetMarketCount() public {
        assertEq(factory.getMarketCount(), 0);
        factory.createMarket(
            address(baseToken), address(quoteToken), TICK_SIZE, MIN_ORDER_SIZE, MAX_ORDER_SIZE
        );
        assertEq(factory.getMarketCount(), 1);
    }

    function testTransferAdmin() public {
        address newAdmin = address(0xCAFE);
        factory.transferAdmin(newAdmin);
        assertEq(factory.admin(), newAdmin);
    }

    function testTransferAdminNotAdmin() public {
        vm.prank(address(0xBEEF));
        vm.expectRevert(DLOBFactory.NotAdmin.selector);
        factory.transferAdmin(address(0xCAFE));
    }

    // ──────────────────── Parameter Validation Tests ─────────────────

    function testRevertZeroTickSize() public {
        vm.expectRevert(DLOBFactory.ZeroTickSize.selector);
        factory.createMarket(
            address(baseToken), address(quoteToken), 0, MIN_ORDER_SIZE, MAX_ORDER_SIZE
        );
    }

    function testRevertZeroMinOrderSize() public {
        vm.expectRevert(DLOBFactory.ZeroMinOrderSize.selector);
        factory.createMarket(address(baseToken), address(quoteToken), TICK_SIZE, 0, MAX_ORDER_SIZE);
    }

    function testRevertMaxBelowMin() public {
        vm.expectRevert(DLOBFactory.MaxBelowMin.selector);
        factory.createMarket(
            address(baseToken), address(quoteToken), TICK_SIZE, MIN_ORDER_SIZE, MIN_ORDER_SIZE - 1
        );
    }

    // ──────────────────── Unidirectional Market Key Tests ─────────────

    function testReverseTokenOrderReverts() public {
        factory.createMarket(
            address(baseToken), address(quoteToken), TICK_SIZE, MIN_ORDER_SIZE, MAX_ORDER_SIZE
        );
        // Creating quoteToken/baseToken should revert — same normalized key
        vm.expectRevert(DLOBFactory.MarketExists.selector);
        factory.createMarket(
            address(quoteToken), address(baseToken), TICK_SIZE, MIN_ORDER_SIZE, MAX_ORDER_SIZE
        );
    }

    function testGetMarketBothDirections() public {
        address dlob = factory.createMarket(
            address(baseToken), address(quoteToken), TICK_SIZE, MIN_ORDER_SIZE, MAX_ORDER_SIZE
        );
        // Both directions should resolve to the same market
        assertEq(factory.getMarket(address(baseToken), address(quoteToken)), dlob);
        assertEq(factory.getMarket(address(quoteToken), address(baseToken)), dlob);
    }
}
