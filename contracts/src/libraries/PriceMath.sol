// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: © 2026 Parity Technologies
pragma solidity ^0.8.20;

/// @title PriceMath
/// @notice Tick alignment and quote amount computation for the DLOB.
library PriceMath {
    /// @notice Check if a price is aligned to the tick size.
    function isTickAligned(uint96 price, uint96 tickSize) internal pure returns (bool) {
        return price % tickSize == 0;
    }

    /// @notice Compute quote amount from base amount and price.
    /// @dev quoteAmount = baseAmount * price / precision
    ///      uint128 * uint96 fits in uint256 (max ~2^224), no overflow possible.
    ///      Rounds down (seller gets less). Use quoteAmountCeil for buyer's cost.
    function quoteAmount(uint128 baseAmount, uint96 price, uint256 precision)
        internal
        pure
        returns (uint128)
    {
        return uint128((uint256(baseAmount) * uint256(price)) / precision);
    }

    /// @notice Compute quote amount, rounding up (for buyer's cost).
    function quoteAmountCeil(uint128 baseAmount, uint96 price, uint256 precision)
        internal
        pure
        returns (uint128)
    {
        uint256 product = uint256(baseAmount) * uint256(price);
        return uint128((product + precision - 1) / precision);
    }
}
