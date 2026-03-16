// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) Parity Technologies (UK) Ltd.
pragma solidity ^0.8.20;

import {ScaleCodec} from "./ScaleCodec.sol";

/// @title XcmBuilder
/// @notice Builds SCALE-encoded XCM V5 messages for cross-chain asset transfers.
/// Extended from the cross-chain-escrow version with dual-asset (DOT + token) support.
library XcmBuilder {
    // --- XCM Version enum indices ---
    uint8 constant XCM_V5 = 5;

    // --- Junction enum indices ---
    uint8 constant JUNCTION_PARACHAIN = 0;
    uint8 constant JUNCTION_ACCOUNT_ID32 = 1;
    uint8 constant JUNCTION_ACCOUNT_KEY20 = 2;
    uint8 constant JUNCTION_PALLET_INSTANCE = 4;
    uint8 constant JUNCTION_GENERAL_INDEX = 5;

    // --- XCM V5 Instruction enum indices (auto-assigned, no codec(index) overrides) ---
    uint8 constant INSTRUCTION_WITHDRAW_ASSET = 0;
    uint8 constant INSTRUCTION_TRANSFER_ASSET = 4;
    uint8 constant INSTRUCTION_DEPOSIT_RESERVE_ASSET = 14;
    uint8 constant INSTRUCTION_BUY_EXECUTION = 19;
    uint8 constant INSTRUCTION_DEPOSIT_ASSET = 13;

    // --- Fungibility / Wild / WeightLimit ---
    uint8 constant FUNGIBLE = 0;
    // AssetFilter::Wild = enum variant 1; WildAsset::All = enum variant 0
    uint8 constant ASSET_FILTER_WILD = 1;
    uint8 constant WILD_ASSET_ALL = 0;
    uint8 constant WEIGHT_LIMIT_UNLIMITED = 0;

    /// @notice Build VersionedLocation for a sibling parachain destination.
    function buildDestination(uint32 paraId) internal pure returns (bytes memory) {
        bytes memory parachainJunction =
            ScaleCodec.encodeEnum(JUNCTION_PARACHAIN, ScaleCodec.encodeCompact(uint256(paraId)));
        bytes memory interior = ScaleCodec.encodeEnum(1, parachainJunction);
        bytes memory location = abi.encodePacked(uint8(1), interior);
        return ScaleCodec.encodeEnum(XCM_V5, location);
    }

    /// @notice Build Location for a local AccountId32 beneficiary.
    function buildLocalBeneficiary(bytes32 accountId32) internal pure returns (bytes memory) {
        bytes memory accountJunction = ScaleCodec.encodeEnum(
            JUNCTION_ACCOUNT_ID32, abi.encodePacked(uint8(0), ScaleCodec.encodeBytes32(accountId32))
        );
        bytes memory interior = ScaleCodec.encodeEnum(1, accountJunction);
        return abi.encodePacked(uint8(0), interior);
    }

    /// @notice Build a DOT asset location (relay chain native token from Asset Hub).
    /// Location { parents: 1, interior: Here }
    function buildDotLocation() internal pure returns (bytes memory) {
        // parents = 1, interior = X0 (enum variant 0, no junctions)
        return abi.encodePacked(uint8(1), uint8(0));
    }

    /// @notice Build a pallet-assets token location.
    /// Location { parents: 0, interior: X2(PalletInstance(palletIndex), GeneralIndex(assetId)) }
    function buildPalletAssetLocation(uint8 palletIndex, uint128 assetId)
        internal
        pure
        returns (bytes memory)
    {
        bytes memory palletJunction =
            ScaleCodec.encodeEnum(JUNCTION_PALLET_INSTANCE, abi.encodePacked(palletIndex));
        bytes memory indexJunction = ScaleCodec.encodeEnum(
            JUNCTION_GENERAL_INDEX, ScaleCodec.encodeCompact(uint256(assetId))
        );
        bytes memory interior =
            ScaleCodec.encodeEnum(2, abi.encodePacked(palletJunction, indexJunction));
        return abi.encodePacked(uint8(0), interior);
    }

    /// @notice Build a dual-asset reserve transfer XCM message (DOT fee + settlement token).
    /// @dev Builds: VersionedXcm::V5([
    ///   WithdrawAsset([ Asset(DOT, dotFee), Asset(token, amount) ]),
    ///   DepositReserveAsset {
    ///     assets: Wild(All),
    ///     dest: Parachain(destParaId),
    ///     xcm: [ BuyExecution(DOT, dotFee, Unlimited), DepositAsset(All, beneficiary) ]
    ///   }
    /// ])
    function buildDualAssetReserveTransfer(
        uint128 dotFee,
        uint8 palletIndex,
        uint128 assetId,
        uint128 amount,
        uint32 destParaId,
        bytes32 beneficiary
    ) internal pure returns (bytes memory) {
        // Build asset locations
        bytes memory dotLocation = buildDotLocation();
        bytes memory tokenLocation = buildPalletAssetLocation(palletIndex, assetId);

        return _buildDualAssetReserveTransferInner(
            dotFee, dotLocation, tokenLocation, amount, destParaId, beneficiary
        );
    }

    /// @notice Build a dual-asset reserve transfer for custom ERC20 tokens.
    function buildDualAssetReserveTransferErc20(
        uint128 dotFee,
        address contractAddress,
        uint128 amount,
        uint32 destParaId,
        bytes32 beneficiary
    ) internal pure returns (bytes memory) {
        bytes memory dotLocation = buildDotLocation();
        // Custom ERC20: Location { parents: 0, interior: X1(AccountKey20 { key, network: None }) }
        bytes memory accountKeyJunction = ScaleCodec.encodeEnum(
            JUNCTION_ACCOUNT_KEY20, abi.encodePacked(uint8(0), bytes20(contractAddress))
        );
        bytes memory tokenInterior = ScaleCodec.encodeEnum(1, accountKeyJunction);
        bytes memory tokenLocation = abi.encodePacked(uint8(0), tokenInterior);

        return _buildDualAssetReserveTransferInner(
            dotFee, dotLocation, tokenLocation, amount, destParaId, beneficiary
        );
    }

    function _buildDualAssetReserveTransferInner(
        uint128 dotFee,
        bytes memory dotLocation,
        bytes memory tokenLocation,
        uint128 amount,
        uint32 destParaId,
        bytes32 beneficiary
    ) private pure returns (bytes memory) {
        // Asset { id: AssetId(location), fun: Fungible(amount) }
        bytes memory dotFungibility =
            ScaleCodec.encodeEnum(FUNGIBLE, ScaleCodec.encodeCompact(uint256(dotFee)));
        bytes memory dotAsset = abi.encodePacked(dotLocation, dotFungibility);

        bytes memory tokenFungibility =
            ScaleCodec.encodeEnum(FUNGIBLE, ScaleCodec.encodeCompact(uint256(amount)));
        bytes memory tokenAsset = abi.encodePacked(tokenLocation, tokenFungibility);

        // Assets = Vec<Asset> with 2 items, sorted by AssetId (Location).
        // XCM V5 requires assets to be in sorted order.
        // Token location (parents=0) sorts before DOT (parents=1).
        bytes memory assets;
        if (_locationLessThan(tokenLocation, dotLocation)) {
            assets = abi.encodePacked(ScaleCodec.encodeCompact(2), tokenAsset, dotAsset);
        } else {
            assets = abi.encodePacked(ScaleCodec.encodeCompact(2), dotAsset, tokenAsset);
        }

        // WithdrawAsset instruction
        bytes memory withdrawAsset = ScaleCodec.encodeEnum(INSTRUCTION_WITHDRAW_ASSET, assets);

        // Inner XCM for destination: [BuyExecution, DepositAsset]
        // BuyExecution.fees is the MAX DOT to take from holding for execution fees.
        // Use 50% of dotFee to leave headroom for XCM delivery fees (charged by
        // DepositReserveAsset on the sending chain before assets reach the destination).
        // The barrier replaces Unlimited with Limited(max_weight), so BuyExecution
        // will actually run; any unspent fees stay in holding for DepositAsset.
        uint128 buyExecFee = dotFee / 2;
        bytes memory buyExecFungibility =
            ScaleCodec.encodeEnum(FUNGIBLE, ScaleCodec.encodeCompact(uint256(buyExecFee)));
        bytes memory buyExecAsset = abi.encodePacked(dotLocation, buyExecFungibility);
        bytes memory buyExecution = ScaleCodec.encodeEnum(
            INSTRUCTION_BUY_EXECUTION,
            abi.encodePacked(buyExecAsset, ScaleCodec.encodeEnum(WEIGHT_LIMIT_UNLIMITED))
        );

        // DepositAsset { assets: Wild(All), beneficiary }
        // AssetFilter::Wild(WildAsset::All) = 0x01 0x00
        bytes memory wildAll = abi.encodePacked(ASSET_FILTER_WILD, WILD_ASSET_ALL);
        bytes memory beneficiaryLocation = buildLocalBeneficiary(beneficiary);
        bytes memory depositAsset = ScaleCodec.encodeEnum(
            INSTRUCTION_DEPOSIT_ASSET, abi.encodePacked(wildAll, beneficiaryLocation)
        );

        // Inner XCM = Vec<Instruction> with 2 instructions
        bytes memory innerXcm =
            abi.encodePacked(ScaleCodec.encodeCompact(2), buyExecution, depositAsset);

        // Destination Location { parents: 1, interior: X1(Parachain(destParaId)) }
        bytes memory parachainJunction =
            ScaleCodec.encodeEnum(JUNCTION_PARACHAIN, ScaleCodec.encodeCompact(uint256(destParaId)));
        bytes memory destInterior = ScaleCodec.encodeEnum(1, parachainJunction);
        bytes memory dest = abi.encodePacked(uint8(1), destInterior);

        // DepositReserveAsset { assets: Wild(All), dest, xcm }
        bytes memory depositReserveAsset = ScaleCodec.encodeEnum(
            INSTRUCTION_DEPOSIT_RESERVE_ASSET, abi.encodePacked(wildAll, dest, innerXcm)
        );

        // Outer XCM = Vec<Instruction> with 2 instructions
        bytes memory xcmProgram =
            abi.encodePacked(ScaleCodec.encodeCompact(2), withdrawAsset, depositReserveAsset);

        // VersionedXcm::V5
        return ScaleCodec.encodeEnum(XCM_V5, xcmProgram);
    }

    /// @notice Lexicographic comparison of two SCALE-encoded Location byte strings.
    /// Used to sort assets in WithdrawAsset per XCM V5 requirements.
    function _locationLessThan(bytes memory a, bytes memory b) private pure returns (bool) {
        uint256 len = a.length < b.length ? a.length : b.length;
        for (uint256 i = 0; i < len; i++) {
            if (a[i] < b[i]) return true;
            if (a[i] > b[i]) return false;
        }
        return a.length < b.length;
    }
}
