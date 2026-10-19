// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: © 2026 Parity Technologies
pragma solidity ^0.8.20;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IXcm} from "./interfaces/IXcm.sol";
import {ISystem} from "./interfaces/ISystem.sol";
import {IDLOBFactory} from "./interfaces/IDLOBFactory.sol";
import {PriceMath} from "./libraries/PriceMath.sol";
import {XcmBuilder} from "./libraries/XcmBuilder.sol";
import {RedBlackTree} from "./libraries/RedBlackTree.sol";
import {TokenConfig} from "./types/TokenConfig.sol";

/// @title DLOB — Decentralized Limit Order Book
/// @notice Cross-chain order book on Asset Hub. One instance per base/quote token pair.
/// @custom:security-contact security@parity.io
/// Deployed by DLOBFactory via EIP-1167 minimal proxy clones.
contract DLOB {
    using SafeERC20 for IERC20;

    // ──────────────────────────── Types ────────────────────────────

    enum Side {
        Buy,
        Sell
    }

    enum OrderStatus {
        Active,
        Cancelled
    }

    enum ClaimType {
        Fill,
        Refund
    }

    struct Order {
        // --- Slot 1 (33 bytes → 2 slots) ---
        address owner; // 20 bytes — msg.sender who placed this order
        Side side; //  1 byte
        OrderStatus status; //  1 byte
        uint96 price; // 12 bytes
        // --- Slot 2 (32 bytes → 1 slot) ---
        uint128 remainingAmount; // 16 bytes
        uint128 originalAmount; // 16 bytes
        // --- Slot 3 (32 bytes → 1 slot) ---
        bytes32 originAccount; // 32 bytes — real user's AccountId32
        // --- Slot 4 (8 bytes → 1 slot) ---
        uint64 expireTimestamp; // 8 bytes — 0 = GTC
    }

    struct OrderLink {
        uint32 prev; // previous order in queue (0 = head)
        uint32 next; // next order in queue (0 = tail)
        uint32 priceNodeId; // which RBNode this order belongs to
        uint32 destParaId; // 0 = local, >0 = destination parachain
    }

    struct PendingClaim {
        address token; // 20 bytes
        ClaimType claimType; //  1 byte
        uint32 destParaId; //  4 bytes
        uint32 orderId; //  4 bytes
        uint128 amount; // 16 bytes
        bytes32 beneficiary; // 32 bytes
    }

    // ──────────────────────── Precompile addresses ─────────────────────

    IXcm internal xcmPrecompile;
    ISystem internal systemPrecompile;

    // ──────────────────────── Config (set once via initialize) ────────

    IERC20 internal baseToken;
    IERC20 internal quoteToken;
    bytes internal baseXcmLocation;
    bytes internal quoteXcmLocation;
    uint96 internal tickSize;
    uint96 internal minOrderSize;
    uint128 internal maxOrderSize;
    IDLOBFactory internal factory;

    // ──────────────────────── Constants ────────────────────────────────

    uint256 internal constant PRECISION = 1e18;
    /// @dev Matching work one transaction may do, in units of proof size. Each fill costs `FILL_COST`,
    /// plus `CROSS_CHAIN_LEG_COST` for each of its two legs settled over XCM; cleaning up an expired
    /// order costs `FILL_COST`. On Asset Hub a local fill needs about 1 MB of proof, a cross-chain leg
    /// adds about 0.5 MB, and one transaction may prove 8 MiB: the budget allows 6 local fills, 4 with
    /// one cross-chain leg, or 3 with two, each using at most about 80% of that limit. An order that
    /// needs more fills what fits and returns the remainder to the sender.
    uint8 internal constant MATCH_BUDGET = 12;
    uint8 internal constant FILL_COST = 2;
    uint8 internal constant CROSS_CHAIN_LEG_COST = 1;

    // ──────────────────────── State ──────────────────────────────

    uint32 public nextOrderId = 1;
    uint32 internal nextNodeId = 1;
    uint32 public nextClaimId = 1;
    uint32 internal totalOrders;

    uint32 internal bidTreeRoot;
    uint32 internal askTreeRoot;

    uint96 public bestBid;
    uint96 public bestAsk;
    uint32 internal bestBidNodeId;
    uint32 internal bestAskNodeId;

    uint8 private _locked;
    bool private _initialized;

    mapping(uint32 => Order) internal orders;
    mapping(uint32 => OrderLink) internal orderLinks;
    mapping(uint32 => bytes32) internal settlementAccounts;
    mapping(uint32 => uint128) internal orderFeeReserve;
    mapping(uint32 => uint16) internal orderPendingClaimCount;
    mapping(uint32 => RedBlackTree.RBNode) internal nodes;
    mapping(uint96 => uint32) internal bidPriceToNode;
    mapping(uint96 => uint32) internal askPriceToNode;
    mapping(uint32 => PendingClaim) internal pendingClaims;

    uint128 public totalFeeReserveBalance;

    // ──────────────────────── Events ─────────────────────────────

    event OrderPlaced(
        uint32 indexed orderId,
        address indexed owner,
        bytes32 originAccount,
        Side side,
        uint96 price,
        uint128 amount,
        uint32 destParaId,
        uint64 expireTimestamp
    );
    event OrderReduced(
        uint32 indexed orderId, uint128 oldAmount, uint128 newAmount, uint128 freedAmount
    );
    event OrderExpired(uint32 indexed orderId, uint128 remainingAmount);
    event OrderCancelled(uint32 indexed orderId, uint128 refundedAmount, uint32 claimId);
    event OrderFilled(uint32 indexed orderId, uint128 filledAmount, uint128 remainingAmount);
    event Trade(
        uint32 indexed buyOrderId, uint32 indexed sellOrderId, uint96 price, uint128 amount
    );
    event ClaimCreated(
        uint32 indexed claimId,
        uint32 indexed orderId,
        ClaimType claimType,
        uint32 destParaId,
        uint128 amount
    );
    event ClaimSettled(uint32 indexed claimId);
    event ClaimRedirected(uint32 indexed claimId, uint32 newDestParaId, bytes32 newBeneficiary);
    event AdminClaimRedirected(
        uint32 indexed claimId, uint32 newDestParaId, bytes32 newBeneficiary, address admin
    );
    event OrphanedDotSwept(address recipient, uint128 amount);
    event PriceLevelCreated(uint96 price, Side side);
    event ExcessQuoteRefunded(uint32 orderId, uint128 amount);
    event PriceLevelRemoved(uint96 price, Side side);

    // ──────────────────────── Errors ─────────────────────────────

    error NotTickAligned();
    error BelowMinSize();
    error AboveMaxSize();
    error OrderIdOverflow();
    error NodeIdOverflow();
    error ClaimIdOverflow();
    error ZeroQuoteAmount();
    error InvalidSettlementAccount();
    error InsufficientFeeReserve();
    error LocalOrderWithValue();
    error OrderNotActive(uint32 orderId);
    error NotOrderOwner();
    error WrongOriginAccount();
    error SelfTrade();
    error AlreadyExpired();
    error NoLiquidity();
    error SlippageExceeded();
    error ReduceOnly();
    error ReduceToZero();
    error ClaimNotFound();
    error InsufficientClaimFee();
    error NotAdmin();
    error ExceedsAvailable();
    error TransferFailed();
    error OrderStillActive();
    error HasPendingClaims();
    error NoExcess();
    error Reentrancy();
    error AlreadyInitialized();
    error Halted();

    // ──────────────────────── Modifiers ──────────────────────────

    modifier nonReentrant() {
        if (_locked == 1) revert Reentrancy();
        _locked = 1;
        _;
        _locked = 0;
    }

    // ──────────────────────── Constructor (lock implementation) ──

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _initialized = true;
    }

    // ──────────────────────── Initializer ────────────────────────

    function initialize(
        TokenConfig calldata base,
        TokenConfig calldata quote,
        uint96 _tickSize,
        uint96 _minOrderSize,
        uint128 _maxOrderSize,
        address _xcm,
        address _system,
        address _factory
    ) external payable {
        if (_initialized) revert AlreadyInitialized();
        _initialized = true;

        baseToken = IERC20(base.token);
        quoteToken = IERC20(quote.token);

        // Always store the XCM location so both asset types have consistent
        // storage. For trust-backed assets the caller passes empty bytes, so
        // we derive the location from the precompile address at init time.
        baseXcmLocation = base.xcmLocation.length > 0
            ? base.xcmLocation
            : XcmBuilder.locationFromPalletAsset(base.token);
        quoteXcmLocation = quote.xcmLocation.length > 0
            ? quote.xcmLocation
            : XcmBuilder.locationFromPalletAsset(quote.token);

        tickSize = _tickSize;
        minOrderSize = _minOrderSize;
        maxOrderSize = _maxOrderSize;
        xcmPrecompile = IXcm(_xcm);
        systemPrecompile = ISystem(_system);
        factory = IDLOBFactory(_factory);

        // Clone storage starts at zero — set counters to 1
        nextOrderId = 1;
        nextNodeId = 1;
        nextClaimId = 1;
    }

    // ──────────────────────── Core Functions ──────────────────────

    /// @notice Place a limit order. It fills against the opposite side, then rests at `price`. When
    /// the match budget runs out first, the order does not rest: its remainder is returned.
    /// @return orderId The new order's id.
    /// @return returned Base amount returned that way (for a buy, its quote is refunded), or 0.
    function placeLimitOrder(
        Side side,
        uint96 price,
        uint128 amount,
        bytes32 originAccount,
        bytes32 settlementAccount,
        uint32 destParaId,
        uint64 expireTimestamp
    ) external payable nonReentrant returns (uint32 orderId, uint128 returned) {
        // --- Validation ---
        if (!PriceMath.isTickAligned(price, tickSize)) revert NotTickAligned();
        _validateOrderParams(amount, settlementAccount, destParaId);
        if (expireTimestamp != 0 && expireTimestamp <= uint64(block.timestamp)) {
            revert AlreadyExpired();
        }

        // --- Calculate escrow ---
        uint128 escrowAmount;
        if (side == Side.Sell) {
            escrowAmount = amount;
        } else {
            uint128 qa = PriceMath.quoteAmountCeil(amount, price, PRECISION);
            if (qa == 0) revert ZeroQuoteAmount();
            escrowAmount = qa;
        }

        // --- Allocate order ID ---
        orderId = nextOrderId++;

        // --- Lock tokens ---
        IERC20 escrowToken = side == Side.Sell ? baseToken : quoteToken;
        escrowToken.safeTransferFrom(msg.sender, address(this), uint256(escrowAmount));

        // --- Store order + fee reserve BEFORE matching (needed for _settleFill) ---
        orders[orderId] = Order({
            owner: msg.sender,
            side: side,
            status: OrderStatus.Active,
            price: price,
            remainingAmount: amount,
            originalAmount: amount,
            originAccount: originAccount,
            expireTimestamp: expireTimestamp
        });
        orderLinks[orderId].destParaId = destParaId;
        if (destParaId > 0) {
            settlementAccounts[orderId] = settlementAccount;
            orderFeeReserve[orderId] = uint128(msg.value);
            totalFeeReserveBalance += uint128(msg.value);
        }

        // --- MATCHING PHASE ---
        uint128 remaining = amount;
        uint128 quoteUsed = 0;
        bool exhausted;

        if (side == Side.Buy) {
            (remaining, quoteUsed, exhausted) =
                _matchBuy(orderId, price, remaining, originAccount, destParaId, 0);
        } else {
            (remaining, exhausted) =
                _matchSell(orderId, price, remaining, originAccount, destParaId, 0);
        }

        // An order the budget stopped while it still crossed would cross the book if it rested at its
        // price, so its remainder goes back to the sender, as a market order's does.
        returned = exhausted ? remaining : 0;
        remaining -= returned;
        if (side == Side.Sell && returned > 0) {
            baseToken.safeTransfer(msg.sender, uint256(returned));
        }

        // Update remaining amount after matching
        orders[orderId].remainingAmount = remaining;

        // --- REFUND EXCESS QUOTE FOR BUY ORDERS ---
        if (side == Side.Buy && (quoteUsed > 0 || returned > 0)) {
            uint128 totalEscrowed = PriceMath.quoteAmountCeil(amount, price, PRECISION);
            uint128 restingEscrow =
                remaining > 0 ? PriceMath.quoteAmountCeil(remaining, price, PRECISION) : 0;
            uint128 excess = totalEscrowed - quoteUsed - restingEscrow;
            if (excess > 0) {
                quoteToken.safeTransfer(msg.sender, uint256(excess));
                emit ExcessQuoteRefunded(orderId, excess);
            }
        }

        // --- RESTING PHASE ---
        if (remaining > 0) {
            // Insert into price tree + queue
            _insertOrder(orderId, side, price);
            totalOrders++;

            emit OrderPlaced(
                orderId,
                msg.sender,
                originAccount,
                side,
                price,
                remaining,
                destParaId,
                expireTimestamp
            );
        }
    }

    /// @notice Place a market order: fill immediately against the opposite side, never rest.
    /// @param limitPrice Worst price accepted: the highest ask a buy takes, or the lowest bid a sell
    /// takes. Matching stops there, so a resting order at an extreme price cannot fill it.
    /// @param minAmountOut Minimum base amount filled, or 0 for no minimum.
    function placeMarketOrder(
        Side side,
        uint128 amount,
        uint96 limitPrice,
        uint128 minAmountOut,
        bytes32 originAccount,
        bytes32 settlementAccount,
        uint32 destParaId
    ) external payable nonReentrant returns (uint128 filledAmount) {
        _validateOrderParams(amount, settlementAccount, destParaId);

        // Allocate temporary orderId for fee reserve tracking
        uint32 orderId = nextOrderId++;

        // Lock tokens
        uint128 escrowAmount;
        if (side == Side.Sell) {
            escrowAmount = amount;
            baseToken.safeTransferFrom(msg.sender, address(this), uint256(escrowAmount));
        } else {
            // For market buy, we lock max possible quote based on best ask
            // Since we don't know the price yet, lock the full amount as base
            // and handle during matching
            escrowAmount = amount;
            // Market buys are specified in base amount — we compute quote during matching
        }

        // Store DOT fee reserve
        if (destParaId > 0) {
            orderFeeReserve[orderId] = uint128(msg.value);
            totalFeeReserveBalance += uint128(msg.value);
        }

        // Store temporary order
        orders[orderId] = Order({
            owner: msg.sender,
            side: side,
            status: OrderStatus.Active,
            price: 0, // market orders have no price
            remainingAmount: amount,
            originalAmount: amount,
            originAccount: originAccount,
            expireTimestamp: 0
        });
        orderLinks[orderId].destParaId = destParaId;
        if (destParaId > 0) {
            settlementAccounts[orderId] = settlementAccount;
        }

        // Match
        uint128 remaining = amount;
        if (side == Side.Buy) {
            (remaining,,) = _matchBuy(orderId, limitPrice, remaining, originAccount, destParaId, 0);
        } else {
            (remaining,) = _matchSell(orderId, limitPrice, remaining, originAccount, destParaId, 0);
        }

        filledAmount = amount - remaining;
        // A market order never rests: nothing of it is left to cancel or reduce.
        orders[orderId].remainingAmount = 0;

        // Slippage check
        if (minAmountOut > 0 && filledAmount < minAmountOut) revert SlippageExceeded();

        // Return unfilled tokens
        if (remaining > 0) {
            if (side == Side.Sell) {
                baseToken.safeTransfer(msg.sender, uint256(remaining));
            }
            // For market buys, unfilled quote is returned during matching
        }

        // Refund unused fee reserve
        uint128 tempFeeReserve = orderFeeReserve[orderId];
        if (tempFeeReserve > 0) {
            orderFeeReserve[orderId] = 0;
            totalFeeReserveBalance -= tempFeeReserve;
            (bool sent,) = payable(msg.sender).call{value: tempFeeReserve}("");
            if (!sent) revert TransferFailed();
        }
    }

    /// @notice Cancel a resting order.
    function cancelOrder(uint32 orderId, bytes32 originAccount) external nonReentrant {
        Order storage o = orders[orderId];
        if (!_isResting(orderId)) revert OrderNotActive(orderId);
        if (msg.sender != o.owner) revert NotOrderOwner();
        if (originAccount != o.originAccount) revert WrongOriginAccount();

        _cancelOrderInternal(orderId, originAccount);
    }

    /// @notice Batch cancel multiple orders.
    function batchCancelOrders(uint32[] calldata orderIds, bytes32 originAccount)
        external
        nonReentrant
    {
        for (uint256 i = 0; i < orderIds.length; i++) {
            uint32 oid = orderIds[i];
            Order storage o = orders[oid];

            // Skip silently if not cancellable
            if (!_isResting(oid)) continue;
            if (msg.sender != o.owner) continue;
            if (originAccount != o.originAccount) continue;

            _cancelOrderInternal(oid, originAccount);
        }
    }

    /// @notice Reduce a resting order's size (reduce-only).
    function reduceOrder(uint32 orderId, uint128 newAmount, bytes32 originAccount)
        external
        nonReentrant
    {
        Order storage o = orders[orderId];
        if (!_isResting(orderId)) revert OrderNotActive(orderId);
        if (msg.sender != o.owner) revert NotOrderOwner();
        if (originAccount != o.originAccount) revert WrongOriginAccount();
        if (newAmount == 0) revert ReduceToZero();
        if (newAmount >= o.remainingAmount) revert ReduceOnly();

        // If below minOrderSize, cancel entirely
        if (newAmount < minOrderSize) {
            _cancelOrderInternal(orderId, originAccount);
            return;
        }

        uint128 oldAmount = o.remainingAmount;
        uint128 freedAmount = oldAmount - newAmount;
        o.remainingAmount = newAmount;

        // Update depth tracking
        uint32 nodeId = orderLinks[orderId].priceNodeId;
        if (nodeId != 0) nodes[nodeId].totalAmount -= freedAmount;

        // Refund what the escrow shrinks by. For a buy, the escrow is rounded up, so the freed amount
        // rounded up on its own could exceed the difference by one unit.
        _refundEscrow(
            orderId,
            _escrowFor(o.side, oldAmount, o.price) - _escrowFor(o.side, newAmount, o.price),
            o.side,
            o.owner
        );

        emit OrderReduced(orderId, oldAmount, newAmount, freedAmount);
    }

    /// @notice Remove expired orders at one price level, refunding their owners. Anyone can call it,
    /// so a backlog of expired orders can be cleared in bounded batches.
    /// @param maxOrders Maximum number of orders examined, expired or not.
    /// @return purged Number of expired orders removed.
    function purgeExpired(Side side, uint96 price, uint32 maxOrders)
        external
        nonReentrant
        returns (uint32 purged)
    {
        uint32 nodeId = side == Side.Buy ? bidPriceToNode[price] : askPriceToNode[price];
        if (nodeId == 0) return 0;

        uint32 orderId = nodes[nodeId].orderHead;
        for (uint32 examined = 0; orderId != 0 && examined < maxOrders; examined++) {
            uint32 next = orderLinks[orderId].next;
            uint64 expiry = orders[orderId].expireTimestamp;
            if (expiry != 0 && uint64(block.timestamp) >= expiry) {
                _expireOrder(orderId);
                purged++;
            }
            orderId = next;
        }
        if (nodes[nodeId].orderCount == 0) _removeLevel(nodeId, side, price);
    }

    /// @notice Execute a cross-chain settlement (fill or refund).
    function claimSettlement(uint32 claimId) external payable nonReentrant {
        PendingClaim storage claim = pendingClaims[claimId];
        if (claim.amount == 0) revert ClaimNotFound();

        uint128 dotForXcm;
        if (claim.claimType == ClaimType.Fill) {
            uint128 feePerSettle = factory.minCrossChainFee();
            uint128 reserve = orderFeeReserve[claim.orderId];

            // The fee comes from the order's reserve first, then from msg.value.
            uint128 fromReserve = reserve >= feePerSettle ? feePerSettle : reserve;
            uint128 fromValue = feePerSettle - fromReserve;
            if (uint128(msg.value) < fromValue) revert InsufficientClaimFee();

            orderFeeReserve[claim.orderId] = reserve - fromReserve;
            totalFeeReserveBalance -= fromReserve;
            dotForXcm = feePerSettle;

            // Refund only the unused part of msg.value. What is left of the reserve stays recorded
            // for the order's owner (withdrawExcessFeeReserve).
            uint128 excess = uint128(msg.value) - fromValue;
            if (excess > 0) {
                (bool sent,) = payable(msg.sender).call{value: excess}("");
                if (!sent) revert TransferFailed();
            }
        } else {
            // Refund: drain all remaining DOT
            dotForXcm = orderFeeReserve[claim.orderId] + uint128(msg.value);
            if (dotForXcm == 0) revert InsufficientClaimFee();
            totalFeeReserveBalance -= orderFeeReserve[claim.orderId];
            orderFeeReserve[claim.orderId] = 0;
        }

        // Build and execute XCM
        bytes memory message = XcmBuilder.buildDualAssetReserveTransfer(
            dotForXcm,
            _resolveLocation(claim.token),
            claim.amount,
            claim.destParaId,
            claim.beneficiary
        );
        IXcm.Weight memory weight = xcmPrecompile.weighMessage(message);
        xcmPrecompile.execute(message, weight);

        // Clear claim
        orderPendingClaimCount[claim.orderId]--;
        delete pendingClaims[claimId];

        emit ClaimSettled(claimId);
    }

    /// @notice Withdraw excess DOT fee reserve from a completed order.
    function withdrawExcessFeeReserve(uint32 orderId) external nonReentrant {
        Order storage o = orders[orderId];
        if (o.remainingAmount != 0 && o.status != OrderStatus.Cancelled) {
            revert OrderStillActive();
        }
        if (orderPendingClaimCount[orderId] != 0) revert HasPendingClaims();
        uint128 excess = orderFeeReserve[orderId];
        if (excess == 0) revert NoExcess();
        orderFeeReserve[orderId] = 0;
        totalFeeReserveBalance -= excess;

        (bool sent,) = payable(o.owner).call{value: excess}("");
        if (!sent) revert TransferFailed();
    }

    /// @notice Redirect a PendingClaim to a different destination parachain, for the same beneficiary.
    function redirectClaim(uint32 claimId, bytes32 originAccount, uint32 newDestParaId)
        external
        nonReentrant
    {
        PendingClaim storage claim = pendingClaims[claimId];
        if (claim.amount == 0) revert ClaimNotFound();
        Order storage o = orders[claim.orderId];
        if (msg.sender != o.owner) revert NotOrderOwner();
        if (originAccount != o.originAccount) revert WrongOriginAccount();

        // Only the destination chain changes. The beneficiary stays the order's settlement account,
        // so a redirect, even by a caller that shares the owner's msg.sender, still pays the trader.
        // Changing the beneficiary takes adminRedirectClaim.
        claim.destParaId = newDestParaId;

        emit ClaimRedirected(claimId, newDestParaId, claim.beneficiary);
    }

    /// @notice Admin emergency redirect.
    function adminRedirectClaim(uint32 claimId, uint32 newDestParaId, bytes32 newBeneficiary)
        external
        nonReentrant
    {
        if (msg.sender != factory.admin()) revert NotAdmin();
        PendingClaim storage claim = pendingClaims[claimId];
        if (claim.amount == 0) revert ClaimNotFound();

        claim.destParaId = newDestParaId;
        claim.beneficiary = newBeneficiary;

        emit AdminClaimRedirected(claimId, newDestParaId, newBeneficiary, msg.sender);
    }

    /// @notice Admin: sweep orphaned DOT from operational reserve.
    function sweepOrphanedDot(address recipient, uint128 amount) external nonReentrant {
        if (msg.sender != factory.admin()) revert NotAdmin();
        uint128 available = uint128(address(this).balance) - totalFeeReserveBalance;
        if (amount > available) revert ExceedsAvailable();

        (bool sent,) = payable(recipient).call{value: amount}("");
        if (!sent) revert TransferFailed();

        emit OrphanedDotSwept(recipient, amount);
    }

    // ──────────────────────── View Functions ──────────────────────

    function getMarketInfo()
        external
        view
        returns (address base, address quote, uint96 tick, uint96 minSize, uint128 maxSize)
    {
        return (address(baseToken), address(quoteToken), tickSize, minOrderSize, maxOrderSize);
    }

    function getBestPrices() external view returns (uint96 bid, uint96 ask) {
        return (bestBid, bestAsk);
    }

    function getSpread() external view returns (uint96) {
        if (bestBid == 0 || bestAsk == 0) return 0;
        if (bestAsk <= bestBid) return 0;
        return bestAsk - bestBid;
    }

    function getOrder(uint32 orderId) external view returns (Order memory) {
        return orders[orderId];
    }

    function getOrderLink(uint32 orderId) external view returns (OrderLink memory) {
        return orderLinks[orderId];
    }

    function getPendingClaim(uint32 claimId) external view returns (PendingClaim memory) {
        return pendingClaims[claimId];
    }

    function getOrderFeeReserve(uint32 orderId) external view returns (uint128) {
        return orderFeeReserve[orderId];
    }

    function getSettlementAccount(uint32 orderId) external view returns (bytes32) {
        return settlementAccounts[orderId];
    }

    function canWithdrawExcessFeeReserve(uint32 orderId) external view returns (bool, uint128) {
        Order storage o = orders[orderId];
        bool canWithdraw = (o.remainingAmount == 0 || o.status == OrderStatus.Cancelled)
            && orderPendingClaimCount[orderId] == 0 && orderFeeReserve[orderId] > 0;
        return (canWithdraw, orderFeeReserve[orderId]);
    }

    function getDepthAtPrice(Side side, uint96 price) external view returns (uint128) {
        uint32 nodeId;
        if (side == Side.Buy) {
            nodeId = bidPriceToNode[price];
        } else {
            nodeId = askPriceToNode[price];
        }
        if (nodeId == 0) return 0;
        return nodes[nodeId].totalAmount;
    }

    function getOrderBook(Side side, uint8 levels)
        external
        view
        returns (uint96[] memory prices, uint128[] memory volumes, uint8 count)
    {
        prices = new uint96[](levels);
        volumes = new uint128[](levels);

        uint32 nodeId;
        if (side == Side.Buy) {
            nodeId = bestBidNodeId;
        } else {
            nodeId = bestAskNodeId;
        }

        count = 0;
        while (nodeId != 0 && count < levels) {
            RedBlackTree.RBNode storage n = nodes[nodeId];
            if (n.totalAmount > 0) {
                prices[count] = n.price;
                volumes[count] = n.totalAmount;
                count++;
            }
            // Navigate to next price level
            if (side == Side.Buy) {
                nodeId = RedBlackTree.predecessor(nodes, nodeId);
            } else {
                nodeId = RedBlackTree.successor(nodes, nodeId);
            }
        }
    }

    // ──────────────────────── Internal: Matching ─────────────────

    function _matchBuy(
        uint32 takerOrderId,
        uint96 maxPrice,
        uint128 remaining,
        bytes32 originAccount,
        uint32 takerDestParaId,
        uint8 used
    ) internal returns (uint128, uint128, bool exhausted) {
        uint128 quoteUsed = 0;
        while (remaining > 0 && bestAskNodeId != 0) {
            RedBlackTree.RBNode storage askNode = nodes[bestAskNodeId];
            if (askNode.price > maxPrice) break;

            uint32 makerOrderId = askNode.orderHead;
            while (makerOrderId != 0 && remaining > 0) {
                Order storage maker = orders[makerOrderId];
                uint32 nextMaker = orderLinks[makerOrderId].next;

                // Lazy expiry. Counts toward MATCH_BUDGET, so expired orders cannot make one
                // transaction's work unbounded.
                bool expired =
                    maker.expireTimestamp != 0 && uint64(block.timestamp) >= maker.expireTimestamp;
                uint8 cost = expired ? FILL_COST : _fillCost(takerDestParaId, makerOrderId);
                if (used + cost > MATCH_BUDGET) {
                    exhausted = true;
                    break;
                }
                used += cost;
                if (expired) {
                    _expireOrder(makerOrderId);
                    makerOrderId = nextMaker;
                    continue;
                }

                // Self-trade check
                if (msg.sender == maker.owner && originAccount == maker.originAccount) {
                    revert SelfTrade();
                }

                uint128 fillAmount =
                    remaining < maker.remainingAmount ? remaining : maker.remainingAmount;

                _settleFill(takerOrderId, makerOrderId, fillAmount, askNode.price);
                quoteUsed += PriceMath.quoteAmount(fillAmount, askNode.price, PRECISION);

                maker.remainingAmount -= fillAmount;
                remaining -= fillAmount;
                askNode.totalAmount -= fillAmount;

                emit Trade(takerOrderId, makerOrderId, askNode.price, fillAmount);
                emit OrderFilled(makerOrderId, fillAmount, maker.remainingAmount);

                if (maker.remainingAmount == 0) {
                    _dequeueOrder(makerOrderId, bestAskNodeId);
                    askNode.orderCount--;
                }

                makerOrderId = nextMaker;
            }

            // If price level empty, remove from tree
            if (askNode.orderCount == 0) _removeLevel(bestAskNodeId, Side.Sell, askNode.price);
            if (exhausted) break;
        }
        return (remaining, quoteUsed, exhausted);
    }

    function _matchSell(
        uint32 takerOrderId,
        uint96 minPrice,
        uint128 remaining,
        bytes32 originAccount,
        uint32 takerDestParaId,
        uint8 used
    ) internal returns (uint128, bool exhausted) {
        while (remaining > 0 && bestBidNodeId != 0) {
            RedBlackTree.RBNode storage bidNode = nodes[bestBidNodeId];
            if (bidNode.price < minPrice) break;

            uint32 makerOrderId = bidNode.orderHead;
            while (makerOrderId != 0 && remaining > 0) {
                Order storage maker = orders[makerOrderId];
                uint32 nextMaker = orderLinks[makerOrderId].next;

                // Lazy expiry. Counts toward MATCH_BUDGET, so expired orders cannot make one
                // transaction's work unbounded.
                bool expired =
                    maker.expireTimestamp != 0 && uint64(block.timestamp) >= maker.expireTimestamp;
                uint8 cost = expired ? FILL_COST : _fillCost(takerDestParaId, makerOrderId);
                if (used + cost > MATCH_BUDGET) {
                    exhausted = true;
                    break;
                }
                used += cost;
                if (expired) {
                    _expireOrder(makerOrderId);
                    makerOrderId = nextMaker;
                    continue;
                }

                // Self-trade check
                if (msg.sender == maker.owner && originAccount == maker.originAccount) {
                    revert SelfTrade();
                }

                uint128 fillAmount =
                    remaining < maker.remainingAmount ? remaining : maker.remainingAmount;

                _settleFill(takerOrderId, makerOrderId, fillAmount, bidNode.price);

                maker.remainingAmount -= fillAmount;
                remaining -= fillAmount;
                bidNode.totalAmount -= fillAmount;

                emit Trade(makerOrderId, takerOrderId, bidNode.price, fillAmount);
                emit OrderFilled(makerOrderId, fillAmount, maker.remainingAmount);

                if (maker.remainingAmount == 0) {
                    _dequeueOrder(makerOrderId, bestBidNodeId);
                    bidNode.orderCount--;
                }

                makerOrderId = nextMaker;
            }

            // If price level empty, remove from tree
            if (bidNode.orderCount == 0) _removeLevel(bestBidNodeId, Side.Buy, bidNode.price);
            if (exhausted) break;
        }
        return (remaining, exhausted);
    }

    // ──────────────────────── Internal: Settlement ───────────────

    /// @dev What a fill against `makerOrderId` costs of `MATCH_BUDGET`.
    function _fillCost(uint32 takerDestParaId, uint32 makerOrderId) internal view returns (uint8) {
        uint8 cost = FILL_COST;
        if (takerDestParaId != 0) cost += CROSS_CHAIN_LEG_COST;
        if (orderLinks[makerOrderId].destParaId != 0) cost += CROSS_CHAIN_LEG_COST;
        return cost;
    }

    function _settleFill(
        uint32 takerOrderId,
        uint32 makerOrderId,
        uint128 fillAmount,
        uint96 executionPrice
    ) internal {
        Order storage taker = orders[takerOrderId];

        uint128 quoteAmt = PriceMath.quoteAmount(fillAmount, executionPrice, PRECISION);

        // Determine who is buyer/seller
        uint32 buyOrderId;
        uint32 sellOrderId;
        if (taker.side == Side.Buy) {
            buyOrderId = takerOrderId;
            sellOrderId = makerOrderId;
        } else {
            buyOrderId = makerOrderId;
            sellOrderId = takerOrderId;
        }

        // Buyer receives base tokens
        uint32 buyerDestParaId = orderLinks[buyOrderId].destParaId;
        if (buyerDestParaId == 0) {
            baseToken.safeTransfer(orders[buyOrderId].owner, uint256(fillAmount));
        } else {
            _settleCrossChainLeg(
                buyOrderId,
                address(baseToken),
                fillAmount,
                buyerDestParaId,
                settlementAccounts[buyOrderId]
            );
        }

        // Seller receives quote tokens
        // For market buy orders (price==0), quote was never escrowed — pull from buyer directly
        bool marketBuy = (taker.side == Side.Buy && taker.price == 0);
        uint32 sellerDestParaId = orderLinks[sellOrderId].destParaId;
        if (sellerDestParaId == 0) {
            if (marketBuy) {
                quoteToken.safeTransferFrom(
                    taker.owner, orders[sellOrderId].owner, uint256(quoteAmt)
                );
            } else {
                quoteToken.safeTransfer(orders[sellOrderId].owner, uint256(quoteAmt));
            }
        } else {
            if (marketBuy) {
                quoteToken.safeTransferFrom(taker.owner, address(this), uint256(quoteAmt));
            }
            _settleCrossChainLeg(
                sellOrderId,
                address(quoteToken),
                quoteAmt,
                sellerDestParaId,
                settlementAccounts[sellOrderId]
            );
        }
    }

    function _settleCrossChainLeg(
        uint32 orderId,
        address token,
        uint128 amount,
        uint32 destParaId,
        bytes32 beneficiary
    ) internal {
        uint128 feePerSettle = factory.minCrossChainFee();

        if (orderFeeReserve[orderId] >= feePerSettle) {
            orderFeeReserve[orderId] -= feePerSettle;
            totalFeeReserveBalance -= feePerSettle;

            bytes memory message = XcmBuilder.buildDualAssetReserveTransfer(
                feePerSettle, _resolveLocation(token), amount, destParaId, beneficiary
            );
            IXcm.Weight memory weight = xcmPrecompile.weighMessage(message);

            try xcmPrecompile.execute(message, weight) {
            // Success
            }
            catch {
                // Restore fee reserve, create fallback claim
                orderFeeReserve[orderId] += feePerSettle;
                totalFeeReserveBalance += feePerSettle;
                _createPendingClaim(orderId, token, amount, destParaId, beneficiary, ClaimType.Fill);
            }
        } else {
            _createPendingClaim(orderId, token, amount, destParaId, beneficiary, ClaimType.Fill);
        }
    }

    function _createPendingClaim(
        uint32 orderId,
        address token,
        uint128 amount,
        uint32 destParaId,
        bytes32 beneficiary,
        ClaimType claimType
    ) internal returns (uint32 claimId) {
        if (nextClaimId >= type(uint32).max) revert ClaimIdOverflow();
        claimId = nextClaimId++;

        pendingClaims[claimId] = PendingClaim({
            token: token,
            claimType: claimType,
            destParaId: destParaId,
            orderId: orderId,
            amount: amount,
            beneficiary: beneficiary
        });

        orderPendingClaimCount[orderId]++;

        emit ClaimCreated(claimId, orderId, claimType, destParaId, amount);
    }

    /// @dev Escrow held for `amount` of an order: base for a sell, quote rounded up for a buy.
    function _escrowFor(Side side, uint128 amount, uint96 price) internal pure returns (uint128) {
        return side == Side.Sell ? amount : PriceMath.quoteAmountCeil(amount, price, PRECISION);
    }

    /// @dev Return `refundEscrow` of the escrowed token (base for a sell, quote for a buy) to the
    /// owner, or as a refund claim for a cross-chain order.
    function _refundEscrow(uint32 orderId, uint128 refundEscrow, Side side, address owner)
        internal
        returns (uint32 claimId)
    {
        uint32 destParaId = orderLinks[orderId].destParaId;

        if (destParaId == 0) {
            IERC20 refundToken = side == Side.Sell ? baseToken : quoteToken;
            refundToken.safeTransfer(owner, uint256(refundEscrow));
        } else {
            address refundTokenAddr = side == Side.Sell ? address(baseToken) : address(quoteToken);
            claimId = _createPendingClaim(
                orderId,
                refundTokenAddr,
                refundEscrow,
                destParaId,
                settlementAccounts[orderId],
                ClaimType.Refund
            );
        }
    }

    /// @dev An order rests on the book when it is active, has an unfilled amount, and was inserted
    /// into a price level. Market orders are never inserted, so they never qualify.
    function _isResting(uint32 orderId) internal view returns (bool) {
        Order storage o = orders[orderId];
        return o.status == OrderStatus.Active && o.remainingAmount != 0
            && orderLinks[orderId].priceNodeId != 0;
    }

    function _cancelOrderInternal(
        uint32 orderId,
        bytes32 /* originAccount */
    )
        internal
    {
        Order storage o = orders[orderId];
        o.status = OrderStatus.Cancelled;
        uint128 refundAmount = o.remainingAmount;

        uint32 nodeId = orderLinks[orderId].priceNodeId;
        if (nodeId != 0) nodes[nodeId].totalAmount -= refundAmount;

        o.remainingAmount = 0;

        _removeOrder(orderId, o.side, o.price);
        totalOrders--;

        uint32 claimId =
            _refundEscrow(orderId, _escrowFor(o.side, refundAmount, o.price), o.side, o.owner);

        emit OrderCancelled(orderId, refundAmount, claimId);
    }

    function _expireOrder(uint32 orderId) internal {
        Order storage o = orders[orderId];
        o.status = OrderStatus.Cancelled;
        uint128 refundAmount = o.remainingAmount;

        uint32 nodeId = orderLinks[orderId].priceNodeId;
        if (nodeId != 0) {
            nodes[nodeId].totalAmount -= refundAmount;
            nodes[nodeId].orderCount--;
        }

        o.remainingAmount = 0;

        _dequeueOrder(orderId, orderLinks[orderId].priceNodeId);

        _refundEscrow(orderId, _escrowFor(o.side, refundAmount, o.price), o.side, o.owner);

        emit OrderExpired(orderId, refundAmount);
    }

    // ──────────────────────── Internal: XCM Location ───────────

    /// @dev Return the stored XCM Location for `token`.
    function _resolveLocation(address token) internal view returns (bytes memory) {
        if (token == address(baseToken)) return baseXcmLocation;
        if (token == address(quoteToken)) return quoteXcmLocation;
        revert("unknown token");
    }

    // ──────────────────────── Internal: Validation ─────────────

    function _validateOrderParams(uint128 amount, bytes32 settlementAccount, uint32 destParaId)
        internal
        view
    {
        // New orders only: cancelling, reducing, claiming and withdrawing stay open while halted.
        if (factory.halted()) revert Halted();
        if (amount < minOrderSize) revert BelowMinSize();
        if (amount > maxOrderSize) revert AboveMaxSize();
        if (nextOrderId >= type(uint32).max) revert OrderIdOverflow();
        if (destParaId > 0 && settlementAccount == bytes32(0)) {
            revert InvalidSettlementAccount();
        }
        if (destParaId == 0 && settlementAccount != bytes32(0)) {
            revert InvalidSettlementAccount();
        }
        if (destParaId > 0 && msg.value < factory.minCrossChainFee()) {
            revert InsufficientFeeReserve();
        }
        if (destParaId == 0 && msg.value > 0) revert LocalOrderWithValue();
    }

    // ──────────────────────── Internal: Order Tree + Queue ───────

    function _insertOrder(uint32 orderId, Side side, uint96 price) internal {
        bool isBuy = (side == Side.Buy);
        mapping(uint96 => uint32) storage priceToNode = isBuy ? bidPriceToNode : askPriceToNode;
        uint32 nodeId = priceToNode[price];

        if (nodeId == 0) {
            if (nextNodeId >= type(uint32).max) revert NodeIdOverflow();
            nodeId = nextNodeId++;
            nodes[nodeId].price = price;
            nodes[nodeId].color = RedBlackTree.Color.Red;
            priceToNode[price] = nodeId;
            if (isBuy) {
                bidTreeRoot = RedBlackTree.insert(nodes, bidTreeRoot, nodeId);
                _updateBestBid();
            } else {
                askTreeRoot = RedBlackTree.insert(nodes, askTreeRoot, nodeId);
                _updateBestAsk();
            }
            emit PriceLevelCreated(price, side);
        }

        // Append order to this node's queue
        _enqueueOrder(orderId, nodeId);
        orderLinks[orderId].priceNodeId = nodeId;
        nodes[nodeId].orderCount++;
        nodes[nodeId].totalAmount += orders[orderId].remainingAmount;
    }

    function _removeOrder(uint32 orderId, Side side, uint96 price) internal {
        uint32 nodeId = orderLinks[orderId].priceNodeId;
        if (nodeId == 0) return;

        _dequeueOrder(orderId, nodeId);
        nodes[nodeId].orderCount--;

        if (nodes[nodeId].orderCount == 0) _removeLevel(nodeId, side, price);
    }

    /// @dev Remove an empty price level from its tree and refresh the best price.
    function _removeLevel(uint32 nodeId, Side side, uint96 price) internal {
        if (side == Side.Buy) {
            delete bidPriceToNode[price];
            bidTreeRoot = RedBlackTree.remove(nodes, bidTreeRoot, nodeId);
            _updateBestBid();
        } else {
            delete askPriceToNode[price];
            askTreeRoot = RedBlackTree.remove(nodes, askTreeRoot, nodeId);
            _updateBestAsk();
        }
        emit PriceLevelRemoved(price, side);
    }

    // --- Queue operations ---

    function _enqueueOrder(uint32 orderId, uint32 nodeId) internal {
        RedBlackTree.RBNode storage n = nodes[nodeId];
        if (n.orderTail == 0) {
            n.orderHead = orderId;
            n.orderTail = orderId;
        } else {
            orderLinks[n.orderTail].next = orderId;
            orderLinks[orderId].prev = n.orderTail;
            n.orderTail = orderId;
        }
    }

    function _dequeueOrder(uint32 orderId, uint32 nodeId) internal {
        OrderLink storage link = orderLinks[orderId];
        RedBlackTree.RBNode storage n = nodes[nodeId];

        if (link.prev != 0) {
            orderLinks[link.prev].next = link.next;
        } else {
            n.orderHead = link.next;
        }

        if (link.next != 0) {
            orderLinks[link.next].prev = link.prev;
        } else {
            n.orderTail = link.prev;
        }

        link.prev = 0;
        link.next = 0;
    }

    function _updateBestBid() internal {
        if (bidTreeRoot == 0) {
            bestBidNodeId = 0;
            bestBid = 0;
        } else {
            bestBidNodeId = RedBlackTree.maximum(nodes, bidTreeRoot);
            bestBid = nodes[bestBidNodeId].price;
        }
    }

    function _updateBestAsk() internal {
        if (askTreeRoot == 0) {
            bestAskNodeId = 0;
            bestAsk = 0;
        } else {
            bestAskNodeId = RedBlackTree.minimum(nodes, askTreeRoot);
            bestAsk = nodes[bestAskNodeId].price;
        }
    }

    /// @notice Allow contract to receive DOT (creation deposit, fee reserves).
    receive() external payable {}
}
