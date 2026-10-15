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

    function _tc(address token) internal pure returns (TokenConfig memory) {
        return TokenConfig(token, "");
    }

    function testCreateMarket() public {
        address dlob = factory.createMarket(
            _tc(address(baseToken)),
            _tc(address(quoteToken)),
            TICK_SIZE,
            MIN_ORDER_SIZE,
            MAX_ORDER_SIZE
        );
        assertTrue(dlob != address(0));
        assertEq(factory.getMarketCount(), 1);
        assertEq(factory.getMarket(address(baseToken), address(quoteToken)), dlob);
    }

    function testCreateDuplicateMarketReverts() public {
        factory.createMarket(
            _tc(address(baseToken)),
            _tc(address(quoteToken)),
            TICK_SIZE,
            MIN_ORDER_SIZE,
            MAX_ORDER_SIZE
        );
        vm.expectRevert(DLOBFactory.MarketExists.selector);
        factory.createMarket(
            _tc(address(baseToken)),
            _tc(address(quoteToken)),
            TICK_SIZE,
            MIN_ORDER_SIZE,
            MAX_ORDER_SIZE
        );
    }

    function testGetMarket() public {
        address dlob = factory.createMarket(
            _tc(address(baseToken)),
            _tc(address(quoteToken)),
            TICK_SIZE,
            MIN_ORDER_SIZE,
            MAX_ORDER_SIZE
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
            _tc(address(baseToken)),
            _tc(address(quoteToken)),
            TICK_SIZE,
            MIN_ORDER_SIZE,
            MAX_ORDER_SIZE
        );
        assertEq(address(dlob).balance, 0.1 ether);
    }

    function testCreateMarketInsufficientDeposit() public {
        factory.setMarketCreationDeposit(0.1 ether);

        vm.expectRevert(DLOBFactory.InsufficientDeposit.selector);
        factory.createMarket{value: 0.05 ether}(
            _tc(address(baseToken)),
            _tc(address(quoteToken)),
            TICK_SIZE,
            MIN_ORDER_SIZE,
            MAX_ORDER_SIZE
        );
    }

    function testCreateMarketSameTokenReverts() public {
        vm.expectRevert(DLOBFactory.SameToken.selector);
        factory.createMarket(
            _tc(address(baseToken)),
            _tc(address(baseToken)),
            TICK_SIZE,
            MIN_ORDER_SIZE,
            MAX_ORDER_SIZE
        );
    }

    function testGetMarketCount() public {
        assertEq(factory.getMarketCount(), 0);
        factory.createMarket(
            _tc(address(baseToken)),
            _tc(address(quoteToken)),
            TICK_SIZE,
            MIN_ORDER_SIZE,
            MAX_ORDER_SIZE
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
            _tc(address(baseToken)), _tc(address(quoteToken)), 0, MIN_ORDER_SIZE, MAX_ORDER_SIZE
        );
    }

    function testRevertZeroMinOrderSize() public {
        vm.expectRevert(DLOBFactory.ZeroMinOrderSize.selector);
        factory.createMarket(
            _tc(address(baseToken)), _tc(address(quoteToken)), TICK_SIZE, 0, MAX_ORDER_SIZE
        );
    }

    function testRevertMaxBelowMin() public {
        vm.expectRevert(DLOBFactory.MaxBelowMin.selector);
        factory.createMarket(
            _tc(address(baseToken)),
            _tc(address(quoteToken)),
            TICK_SIZE,
            MIN_ORDER_SIZE,
            MIN_ORDER_SIZE - 1
        );
    }

    // ──────────────────── Admin-Only Creation and XCM Locations ─────────

    // Precompile addresses: trust-backed assets end in 0x01200000, foreign assets in 0x02200000,
    // with the asset id or index in the top 4 bytes.
    address constant USDT = 0x000007c000000000000000000000000001200000; // trust-backed, id 1984
    address constant TNVDA = 0x02FaF33B00000000000000000000000001200000; // trust-backed
    address constant WETH = 0x0000000500000000000000000000000002200000; // foreign, index 5
    address constant WBTC = 0x0000000600000000000000000000000002200000; // foreign, index 6

    function _create(TokenConfig memory base, TokenConfig memory quote) internal returns (address) {
        return factory.createMarket(base, quote, TICK_SIZE, MIN_ORDER_SIZE, MAX_ORDER_SIZE);
    }

    function testCreateMarketNotAdmin() public {
        vm.prank(address(0xBEEF));
        vm.expectRevert(DLOBFactory.NotAdmin.selector);
        _create(_tc(address(baseToken)), _tc(address(quoteToken)));
    }

    function testCreateMarketFollowsAdminTransfer() public {
        address newAdmin = address(0xCAFE);
        factory.transferAdmin(newAdmin);

        vm.expectRevert(DLOBFactory.NotAdmin.selector);
        _create(_tc(address(baseToken)), _tc(address(quoteToken)));

        vm.prank(newAdmin);
        assertTrue(_create(_tc(address(baseToken)), _tc(address(quoteToken))) != address(0));
    }

    function testTrustBackedPairCreatesWithDerivedLocations() public {
        assertTrue(_create(_tc(TNVDA), _tc(USDT)) != address(0));
    }

    function testTrustBackedTokenRejectsLocation() public {
        vm.expectRevert(DLOBFactory.TrustBackedLocation.selector);
        _create(TokenConfig(TNVDA, hex"0102"), _tc(USDT));
    }

    function testForeignTokenNeedsLocation() public {
        vm.expectRevert(DLOBFactory.MissingForeignLocation.selector);
        _create(_tc(WETH), _tc(USDT));

        assertTrue(_create(TokenConfig(WETH, hex"0102"), _tc(USDT)) != address(0));
    }

    function testForeignLocationOfTheOtherTokenReverts() public {
        // WETH configured with USDT's own location would settle WETH legs in USDT.
        bytes memory usdtLocation =
            XcmBuilder.buildPalletAssetLocation(XcmBuilder.ASSETS_PALLET_INDEX, 1984);
        vm.expectRevert(DLOBFactory.SameLocation.selector);
        _create(TokenConfig(WETH, usdtLocation), _tc(USDT));
    }

    function testSameForeignLocationsRevert() public {
        vm.expectRevert(DLOBFactory.SameLocation.selector);
        _create(TokenConfig(WETH, hex"0102"), TokenConfig(WBTC, hex"0102"));
    }

    // ──────────────────── Unidirectional Market Key Tests ─────────────

    function testReverseTokenOrderReverts() public {
        factory.createMarket(
            _tc(address(baseToken)),
            _tc(address(quoteToken)),
            TICK_SIZE,
            MIN_ORDER_SIZE,
            MAX_ORDER_SIZE
        );
        // Creating quoteToken/baseToken should revert — same normalized key
        vm.expectRevert(DLOBFactory.MarketExists.selector);
        factory.createMarket(
            _tc(address(quoteToken)),
            _tc(address(baseToken)),
            TICK_SIZE,
            MIN_ORDER_SIZE,
            MAX_ORDER_SIZE
        );
    }

    function testGetMarketBothDirections() public {
        address dlob = factory.createMarket(
            _tc(address(baseToken)),
            _tc(address(quoteToken)),
            TICK_SIZE,
            MIN_ORDER_SIZE,
            MAX_ORDER_SIZE
        );
        // Both directions should resolve to the same market
        assertEq(factory.getMarket(address(baseToken), address(quoteToken)), dlob);
        assertEq(factory.getMarket(address(quoteToken), address(baseToken)), dlob);
    }
}
