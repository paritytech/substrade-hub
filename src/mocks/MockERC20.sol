// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) Parity Technologies (UK) Ltd.
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @title MockERC20
/// @notice Stands in for the ERC20 precompile (0x120X addresses) during local testing.
contract MockERC20 is ERC20 {
    constructor(string memory name_, string memory symbol_) ERC20(name_, symbol_) {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function burn(address from, uint256 amount) external {
        _burn(from, amount);
    }
}
