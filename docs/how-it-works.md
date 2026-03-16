[← Back to README](../README.md)

# How It Works

SubsTrade Hub runs an entire limit order book on-chain: order placement, matching, and settlement all execute inside smart contracts on Asset Hub with no off-chain relayers or centralized infrastructure. Unlike other on-chain order books that serve a single chain, SubsTrade Hub is natively multi-chain: traders on any Polkadot parachain can place and settle orders via XCM in a single extrinsic, without bridging tokens manually or managing accounts on Asset Hub.

## Key Features

- **Price-time priority matching.** Orders fill at the best available price first; within the same price level, earlier orders fill before later ones (FIFO). A single transaction can execute up to 50 fills, sweeping multiple price levels if needed.
- **Cross-chain settlement via XCM.** Matched tokens are delivered to any Polkadot parachain using XCM reserve transfers. Traders on remote parachains place and settle orders without leaving their home chain. A single extrinsic handles token transfer, approval, and order placement atomically.
- **Pending claim fallback.** If inline XCM delivery fails (e.g., destination chain congested, HRMP channel full), a `PendingClaim` is created instead of reverting. Funds remain safe on Asset Hub; anyone can call `claimSettlement()` later to retry, or `redirectClaim()` to reroute to a different destination. No funds are ever lost.
- **Limit and market orders.** `placeLimitOrder()` rests on the book at a specific price with an optional expiry timestamp; `placeMarketOrder()` fills immediately against resting orders with a `minAmountOut` slippage protection parameter. Market orders never rest on the book.
- **Order management.** Cancel individual orders or batch cancel multiple orders in one transaction. `reduceOrder()` shrinks a resting order's amount without losing its place in the FIFO queue. `redirectClaim()` lets owners change the settlement destination of a pending claim.
- **Lazy expiry.** Orders with an expiry timestamp are not removed by a keeper or cron job. Instead, expired orders are skipped and cleaned up during matching when the engine encounters them. Zero off-chain infrastructure required.
- **Self-trade prevention.** The matching engine checks both `msg.sender` and `originAccount` (the trader's Substrate AccountId32). If an incoming order would match against a resting order from the same owner and the same origin account, the transaction reverts with `SelfTrade`. This prevents wash trading while still allowing the same entity to trade from different parachains.
- **Red-Black Tree price levels.** Bid and ask prices are stored in a self-balancing red-black tree, giving O(log n) insert and remove with O(1) best bid/ask lookup. Each tree node holds a FIFO queue (doubly-linked list) of orders at that price level.

## Order Lifecycle

1. **Place.** A trader submits a limit order (buy or sell) with a price and amount. The order book escrows the relevant tokens (base for sells, quote for buys) and inserts the order at the correct price level. See [configuration](configuration.md) for market parameter details (tick size, order size limits).
2. **Match.** When a new order crosses the spread (bid >= ask), the matching engine fills orders in **price-time priority** (best price first, then FIFO within each price level). A single transaction can execute up to 50 fills.
3. **Settle.** Matched tokens are delivered to the counterparties. For local (Asset Hub) traders, this is a direct token transfer. For cross-chain traders, settlement uses XCM reserve transfers to deliver tokens to the destination parachain.
4. **Cancel / Expire.** Unfilled orders can be cancelled by the owner at any time. Orders with an expiry timestamp are lazily cleaned during matching; no keeper or cron job needed.

### Limit Orders vs Market Orders

The DLOB supports two order types:

- **`placeLimitOrder()`:** Rests on the book at a specific price. If the price crosses the spread, the order fills immediately (up to 50 fills); any unfilled remainder stays on the book. An optional `expireTimestamp` causes the order to be skipped (and lazily removed) during matching after expiry.
- **`placeMarketOrder()`:** Fills immediately against resting orders and never rests on the book. Requires a `minAmountOut` parameter for slippage protection; the transaction reverts if the filled amount is below this threshold. If there is insufficient liquidity, the call reverts with `NoLiquidity`.

### Matching Engine Details

The matching engine runs inline during order placement. When a new order crosses the spread, the engine walks the opposite side of the book starting from the best price:

1. For each price level, it dequeues orders in FIFO order (earliest first)
2. Each fill transfers tokens between the maker and taker. Buy orders always execute at the **ask price** (the maker's price), so buyers may get a better price than their limit
3. If a buy order fills at a price lower than its limit, the excess quote tokens are refunded to the buyer immediately
4. The engine stops after **50 fills** (`MAX_FILLS_PER_TX`). If the incoming order still has remaining amount, it rests on the book at its limit price
5. Expired orders encountered during the walk are skipped and lazily removed; they don't count toward the 50-fill cap

### Self-Trade Prevention

The DLOB prevents wash trading by checking both `msg.sender` (the EVM caller) and `originAccount` (the Substrate AccountId32 passed as a parameter). If an incoming order would match against a resting order from the same owner **and** the same origin account, the transaction reverts with `SelfTrade`. This allows the same trader to legitimately hold orders on both sides from different origin accounts (e.g., different parachains).

### Order Management

Beyond placement and cancellation, the DLOB supports:

- **`reduceOrder()`:** Shrink a resting order's amount without cancelling it, keeping its place in the FIFO queue. If the new amount falls below `minOrderSize`, the order is cancelled automatically instead.
- **`batchCancelOrders()`:** Cancel multiple orders in a single transaction to save gas.
- **`redirectClaim()`:** Change the destination parachain and beneficiary of a `PendingClaim` before settling it. Useful if the original destination is unreachable.

## Cross-Chain Flow

All tokens in the order book are **Asset Hub native assets** (pallet-assets). Traders on **any Polkadot parachain** can place and settle orders without leaving their home chain; XCM handles the token movement:

```
  Parachain A                  Asset Hub                  Parachain B
    (Buyer)                  (Order Book)                   (Seller)
       |                          |                            |
       |-- quote tokens + order ->|                            |
       |                          |<- base tokens + order -----|
       |                          |                            |
       |                     [matching]                        |
       |                          |                            |
       |<---- base tokens --------|                            |
       |    (settlement)          |------- quote tokens ------>|
       |                          |         (settlement)       |
```

The buyer sends quote tokens (e.g., USDT) to Asset Hub and receives base tokens (e.g., [XAUT](https://gold.tether.to/), Tether Gold, a tokenized gold asset) after matching. The seller does the opposite. Any asset registered on Asset Hub via `pallet-assets` can be traded, and each asset is accessible as an ERC20 through a deterministic [precompile address](https://docs.polkadot.com/smart-contracts/precompiles/erc20/).

### Supported Asset Types

- **Trust-backed assets** — *supported.* Local assets registered via `pallet-assets` with ERC20 precompiles at prefix `0x120`. This includes assets like USDT (asset ID 1984 on Polkadot Asset Hub) and USDC (asset ID 1337 on Polkadot Asset Hub). These work fully for both local and cross-chain orders.

- **Foreign assets** — *planned.* Assets originating from other consensus systems (KSM, WETH, ETH, WBTC) are registered on Asset Hub via `pallet-assets`, but their ERC20 precompile (prefix `0x220`) is not yet enabled in the runtime. Once it is, supporting foreign asset markets (e.g., WETH/USDT, WBTC/USDC) is a future goal. Local-only orders would work immediately through the standard IERC20 interface, but cross-chain settlement would require contract updates to handle the different XCM Location structure that foreign assets use.

- **User-deployed ERC20 contracts** — *not supported.* Standard Solidity tokens deployed via pallet-revive are not supported, even though they implement the same IERC20 interface. A deployed ERC20 contract stores balances in its own contract storage, invisible to the runtime and the XCM executor. `pallet-assets` tokens, in contrast, exist in native runtime storage. The ERC20 precompile is a Solidity-compatible view into that same storage: calling `transfer()` on a precompile address updates the same balances that XCM reads and writes. Because cross-chain settlement relies on XCM, which can only move assets the runtime knows about, only `pallet-assets`-backed tokens can participate. Even for local-only orders, the DLOB uses the same precompile token interface for consistency.

### Local vs Cross-Chain Orders

The DLOB distinguishes between local and cross-chain orders based on `destParaId`:

- **Local order** (`destParaId == 0`): Both escrow and settlement happen via direct ERC20 transfers on Asset Hub. No XCM involved, no fee reserve required. Sending `msg.value` with a local order reverts with `LocalOrderWithValue`.
- **Cross-chain order** (`destParaId != 0`): Tokens arrive via XCM, and settlement is delivered via XCM reserve transfer. Requires a DOT fee reserve (`msg.value >= factory.minCrossChainFee()`).

Both order types require the caller to have an **ERC-20 allowance** set before placing an order. The DLOB contract escrows tokens via `transferFrom`, so traders must first call `approve(marketAddress, amount)` on the relevant token precompile. For buy orders, approve the quote token; for sell orders, approve the base token. For cross-chain orders, the parachain's sovereign account on Asset Hub is the one that needs the allowance.

## Placing an Order from Another Parachain

The DLOB contract lives on Asset Hub and accepts calls from any origin. Traders on other parachains interact with it via **XCM `Transact`**, which calls `pallet_revive::call()`, the Substrate extrinsic for invoking EVM contracts with a native value transfer.

A user on Parachain A signs **one extrinsic** on their home chain, which sends an XCM program to Asset Hub that deposits tokens, approves the DLOB, and places the order atomically:

```
XCM Program (Parachain A → Asset Hub)
──────────────────────────────────────

1. Transfer tokens + DOT to Asset Hub
   ────────────────────────────────────
   The XCM program carries the traded tokens (e.g., USDT) and DOT
   from the user's home chain to their derived account on Asset Hub.
   DOT covers both XCM execution fees and the order's fee reserve.

2. WithdrawAsset + BuyExecution
   ────────────────────────────────────
   A portion of the DOT pays for XCM execution weight on Asset Hub.

3. Transact → pallet_revive::call(dest: TOKEN, data: approve(DLOB, amount))
   ────────────────────────────────────
   ERC20 approve: allows the DLOB market contract to escrow the tokens.
   Tokens live on Asset Hub as pallet-assets with ERC20 precompiles,
   so the approve call goes to the token's precompile address.

4. Transact → pallet_revive::call(dest: DLOB, value: feeReserve, data: placeLimitOrder(...))
   ────────────────────────────────────
   Places the order on the DLOB. The `value` field carries the DOT
   fee reserve, which becomes `msg.value` inside the EVM.

   Order parameters include:
   • originAccount     : user's AccountId32 (self-trade prevention)
   • settlementAccount : where to deliver matched tokens on home chain
   • destParaId        : home parachain ID (e.g., 2034 for Hydration)
```

The user never manages an Asset Hub account directly. Tokens flow through a derived account during XCM execution and end up escrowed in the DLOB, all in one atomic operation.

## Settlement Delivery

When a cross-chain order is filled, the DLOB automatically sends matched tokens to the trader's `settlementAccount` on `destParaId` via an XCM reserve transfer. The DOT fee reserve (sent as `msg.value` with the order) covers the XCM execution cost.

Settlement uses `XcmBuilder.buildDualAssetReserveTransfer()` to construct an XCM V5 message that carries both the traded token and DOT (for execution fees on the destination chain) in a single reserve transfer. The message is executed via the XCM precompile at `0x00000000000000000000000000000000000A0000`.

The fee reserve is split across fills: if an order receives multiple partial fills, each fill consumes a proportional share of the total fee reserve to fund its own settlement delivery.

## Fee Reserve

Each cross-chain order must include a DOT fee reserve (`msg.value >= factory.minCrossChainFee()`). This reserve pays for XCM settlement delivery when the order is filled. If an order is cancelled before being filled, the fee reserve is returned via XCM to the user's home chain as a `PendingClaim` of type `Refund`.

### Excess Fee Reserve

If an order is fully filled and DOT remains in the fee reserve (e.g., the order required fewer settlement deliveries than expected), the owner can call `withdrawExcessFeeReserve(orderId)` to reclaim the unused DOT. The view function `canWithdrawExcessFeeReserve(orderId)` returns whether excess exists and how much.

## PendingClaim Fallback

If inline XCM settlement fails (e.g., destination chain is congested, HRMP channel full), a `PendingClaim` is created instead. Funds remain safe on Asset Hub, and anyone can call `claimSettlement(claimId)` later to retry the XCM delivery. No funds are ever lost.

Each pending claim stores:

| Field         | Description                                          |
| ------------- | ---------------------------------------------------- |
| `token`       | ERC20 address of the token to deliver                |
| `claimType`   | `Fill` (matched tokens) or `Refund` (cancelled order fee reserve) |
| `destParaId`  | Target parachain for delivery                        |
| `orderId`     | The order that generated this claim                  |
| `amount`      | Token amount to deliver                              |
| `beneficiary` | AccountId32 on the destination chain                 |

An order with pending claims cannot be cancelled; the `HasPendingClaims` error prevents it. The `orderPendingClaimCount` must reach zero before cancellation is allowed.

### Claim Redirect

If a destination chain becomes unreachable (e.g., HRMP channel closed), the claim owner can call `redirectClaim(claimId, originAccount, newDestParaId, newBeneficiary)` to reroute delivery to a different parachain. The factory admin can also redirect any claim via `adminRedirectClaim()` as a safety measure.

## Destination Chain Requirements

For a parachain to place and receive orders on the DLOB:

1. **HRMP channel.** Open channel between Asset Hub and the destination parachain.
2. **Asset recognition.** The destination chain must accept the traded asset as a reserve-backed foreign asset from Asset Hub (via a foreign assets pallet or XCM `AssetTransactor`).
3. **XCM barriers.** The chain's XCM configuration must permit reserve transfers from Asset Hub.
4. **Sovereign account mapping.** The parachain's sovereign account on Asset Hub must be registered in `pallet_revive` via `map_account()` before it can interact with contracts. This can be done once via an XCM Transact that calls `pallet_revive::map_account()`, or by any account on Asset Hub calling it on behalf of the sovereign.

Most Polkadot parachains already accept common Asset Hub tokens. Parachains with active HRMP channels to Asset Hub that can receive settled tokens include:

- **[Hydration](https://hydration.net/)** (2034): DEX and liquidity hub, the most active cross-chain destination from Asset Hub
- **[Moonbeam](https://moonbeam.network/)** (2004): EVM-compatible smart contract platform with a broad DeFi ecosystem
- **[Bifrost](https://bifrost.io/)** (2030): Liquid staking protocol supporting DOT and other assets

> **Note:** Cross-chain settlement depends on the destination chain's runtime configuration, HRMP channel health, and asset registration. Parachains may upgrade their runtime, close channels, or stop accepting certain assets at any time. If delivery fails for any reason, a `PendingClaim` is created. Funds remain safe on Asset Hub and can be retried via `claimSettlement()` or redirected to a different destination via `redirectClaim()`.
