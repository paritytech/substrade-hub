// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: © 2026 Parity Technologies
pragma solidity ^0.8.20;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @title Faucet
/// @notice Self-service test-token dispenser for the SubsTrade Hub demo. Holds a pre-funded balance of a
/// single token (tUSD) and lets any caller claim a fixed `dripAmount`, rate-limited per address by a
/// `cooldown`. It never mints — pre-fund it by transferring the token in (the asset admin can mint
/// straight to this contract's address), and refill the same way. The `owner` can retune the drip and
/// recover the balance.
contract Faucet {
    using SafeERC20 for IERC20;

    IERC20 public immutable token;
    uint256 public dripAmount;
    uint256 public cooldown;
    address public owner;

    /// @notice Last claim timestamp per address (0 = never claimed).
    mapping(address => uint256) public lastClaim;

    error CooldownActive(uint256 retryAt);
    error FaucetEmpty();
    error NotOwner();

    event Claimed(address indexed to, uint256 amount);
    event DripUpdated(uint256 dripAmount, uint256 cooldown);
    event Withdrawn(address indexed to, uint256 amount);

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    constructor(IERC20 token_, uint256 dripAmount_, uint256 cooldown_) {
        token = token_;
        dripAmount = dripAmount_;
        cooldown = cooldown_;
        owner = msg.sender;
    }

    /// @notice Send `dripAmount` of the token to the caller. First claim is always allowed; subsequent
    /// claims are gated by `cooldown`. Reverts if the faucet's balance can't cover a drip.
    function claim() external {
        uint256 last = lastClaim[msg.sender];
        if (last != 0 && block.timestamp < last + cooldown) revert CooldownActive(last + cooldown);
        if (token.balanceOf(address(this)) < dripAmount) revert FaucetEmpty();
        lastClaim[msg.sender] = block.timestamp; // effects before interaction
        token.safeTransfer(msg.sender, dripAmount);
        emit Claimed(msg.sender, dripAmount);
    }

    /// @notice Seconds until `who` may claim again (0 if claimable now / never claimed).
    function claimableIn(address who) external view returns (uint256) {
        uint256 last = lastClaim[who];
        if (last == 0) return 0;
        uint256 next = last + cooldown;
        return block.timestamp >= next ? 0 : next - block.timestamp;
    }

    function setDrip(uint256 dripAmount_, uint256 cooldown_) external onlyOwner {
        dripAmount = dripAmount_;
        cooldown = cooldown_;
        emit DripUpdated(dripAmount_, cooldown_);
    }

    /// @notice Recover tokens (top up a replacement faucet, or reclaim leftovers).
    function withdraw(address to, uint256 amount) external onlyOwner {
        token.safeTransfer(to, amount);
        emit Withdrawn(to, amount);
    }
}
