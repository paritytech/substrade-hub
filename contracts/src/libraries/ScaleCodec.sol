// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: © 2026 Parity Technologies
pragma solidity ^0.8.20;

/// @title ScaleCodec
/// @notice Minimal SCALE encoding library for building XCM messages on-chain.
/// @dev Reference: https://docs.polkadot.com/polkadot-protocol/parachain-basics/data-encoding
library ScaleCodec {
    /// @notice SCALE compact encoding for unsigned integers.
    function encodeCompact(uint256 value) internal pure returns (bytes memory) {
        if (value < 64) {
            return abi.encodePacked(uint8(value << 2));
        } else if (value < 1 << 14) {
            uint16 encoded = uint16(value << 2) | 0x01;
            return abi.encodePacked(_swapBytes2(encoded));
        } else if (value < 1 << 30) {
            uint32 encoded = uint32(value << 2) | 0x02;
            return abi.encodePacked(_swapBytes4(encoded));
        } else {
            bytes memory valueBytes = _encodeUintMinimal(value);
            uint8 prefix = uint8((valueBytes.length - 4) << 2) | 0x03;
            return abi.encodePacked(prefix, valueBytes);
        }
    }

    function encodeU32(uint32 value) internal pure returns (bytes memory) {
        return abi.encodePacked(_swapBytes4(value));
    }

    function encodeU64(uint64 value) internal pure returns (bytes memory) {
        return abi.encodePacked(_swapBytes8(value));
    }

    function encodeU128(uint128 value) internal pure returns (bytes memory) {
        return abi.encodePacked(_swapBytes16(value));
    }

    function encodeBytes32(bytes32 value) internal pure returns (bytes memory) {
        return abi.encodePacked(value);
    }

    function encodeEnum(uint8 index, bytes memory data) internal pure returns (bytes memory) {
        return abi.encodePacked(index, data);
    }

    function encodeEnum(uint8 index) internal pure returns (bytes memory) {
        return abi.encodePacked(index);
    }

    // --- Internal byte-swap helpers (big-endian → little-endian) ---

    function _swapBytes2(uint16 v) private pure returns (bytes2) {
        v = (v >> 8) | (v << 8);
        return bytes2(v);
    }

    function _swapBytes4(uint32 v) private pure returns (bytes4) {
        v = ((v & 0xFF00FF00) >> 8) | ((v & 0x00FF00FF) << 8);
        v = (v >> 16) | (v << 16);
        return bytes4(v);
    }

    function _swapBytes8(uint64 v) private pure returns (bytes8) {
        v = ((v & 0xFF00FF00FF00FF00) >> 8) | ((v & 0x00FF00FF00FF00FF) << 8);
        v = ((v & 0xFFFF0000FFFF0000) >> 16) | ((v & 0x0000FFFF0000FFFF) << 16);
        v = (v >> 32) | (v << 32);
        return bytes8(v);
    }

    function _swapBytes16(uint128 v) private pure returns (bytes16) {
        v = ((v & 0xFF00FF00FF00FF00FF00FF00FF00FF00) >> 8)
            | ((v & 0x00FF00FF00FF00FF00FF00FF00FF00FF) << 8);
        v = ((v & 0xFFFF0000FFFF0000FFFF0000FFFF0000) >> 16)
            | ((v & 0x0000FFFF0000FFFF0000FFFF0000FFFF) << 16);
        v = ((v & 0xFFFFFFFF00000000FFFFFFFF00000000) >> 32)
            | ((v & 0x00000000FFFFFFFF00000000FFFFFFFF) << 32);
        v = (v >> 64) | (v << 64);
        return bytes16(v);
    }

    function _encodeUintMinimal(uint256 value) private pure returns (bytes memory) {
        if (value == 0) return abi.encodePacked(uint8(0));

        uint256 temp = value;
        uint256 byteLen = 0;
        while (temp > 0) {
            byteLen++;
            temp >>= 8;
        }

        bytes memory result = new bytes(byteLen);
        for (uint256 i = 0; i < byteLen; i++) {
            result[i] = bytes1(uint8(value & 0xFF));
            value >>= 8;
        }
        return result;
    }
}
