[← Back to README](../README.md)

# How It Works

SubsTrade Hub runs an entire limit order book on-chain: order placement, matching, and settlement all execute inside smart contracts on Asset Hub with no off-chain relayers or centralized infrastructure. Unlike other on-chain order books that serve a single chain, SubsTrade Hub is natively multi-chain: traders on any Polkadot parachain can place and settle orders via XCM in a single extrinsic, without bridging tokens manually or managing accounts on Asset Hub.

## Key Features

- **Price-time priority matching.** Orders fill at the best available price first; within the same price level, earlier orders fill before later ones (FIFO). A single transaction can execute up to 6 fills, sweeping multiple price levels if needed.
- **Cross-chain settlement via XCM.** Matched tokens are delivered to any Polkadot parachain using XCM reserve transfers. Traders on remote parachains place and settle orders without leaving their home chain. A single extrinsic handles token transfer, approval, and order placement atomically.
- **Pending claim fallback.** If inline XCM delivery fails (e.g., destination chain congested, HRMP channel full), a `PendingClaim` is created instead of reverting. Funds remain safe on Asset Hub; anyone can call `claimSettlement()` later to retry, or `redirectClaim()` to reroute to a different destination. No funds are ever lost.
- **Limit and market orders.** `placeLimitOrder()` rests on the book at a specific price with an optional expiry timestamp; `placeMarketOrder()` fills immediately against resting orders, up to a `limitPrice` and with a `minAmountOut` minimum fill. Market orders never rest on the book.
- **Order management.** Cancel individual orders or batch cancel multiple orders in one transaction. `reduceOrder()` shrinks a resting order's amount without losing its place in the FIFO queue. `redirectClaim()` lets owners move a pending claim to another destination parachain.
- **Lazy expiry.** Orders with an expiry timestamp are not removed by a keeper or cron job. Instead, expired orders are skipped and cleaned up during matching when the engine encounters them, and anyone can clear expired orders at a price level with `purgeExpired()`. Zero off-chain infrastructure required.
- **Self-trade prevention.** The matching engine checks both `msg.sender` and `originAccount` (the trader's Substrate AccountId32). If an incoming order would match against a resting order from the same owner and the same origin account, the transaction reverts with `SelfTrade`. This prevents wash trading while still allowing the same entity to trade from different parachains.
- **Red-Black Tree price levels.** Bid and ask prices are stored in a self-balancing red-black tree, giving O(log n) insert and remove with O(1) best bid/ask lookup. Each tree node holds a FIFO queue (doubly-linked list) of orders at that price level.

## Order Lifecycle

1. **Place.** A trader submits a limit order (buy or sell) with a price and amount. The order book escrows the relevant tokens (base for sells, quote for buys) and inserts the order at the correct price level. See [configuration](configuration.md) for market parameter details (tick size, order size limits).
2. **Match.** When a new order crosses the spread (bid >= ask), the matching engine fills orders in **price-time priority** (best price first, then FIFO within each price level). A single transaction can execute up to 6 fills.
3. **Settle.** Matched tokens are delivered to the counterparties. For local (Asset Hub) traders, this is a direct token transfer. For cross-chain traders, settlement uses XCM reserve transfers to deliver tokens to the destination parachain.
4. **Cancel / Expire.** Unfilled orders can be cancelled by the owner at any time. Orders with an expiry timestamp are lazily cleaned during matching; no keeper or cron job needed.

### Limit Orders vs Market Orders

The DLOB supports two order types:

- **`placeLimitOrder()`:** Rests on the book at a specific price. If the price crosses the spread, the order fills immediately (up to 6 fills); any unfilled remainder stays on the book. An optional `expireTimestamp` causes the order to be skipped (and lazily removed) during matching after expiry.
- **`placeMarketOrder()`:** Fills immediately against resting orders and never rests on the book. `limitPrice` is the worst price accepted (the highest ask a buy takes, the lowest bid a sell takes), so a resting order at an extreme price cannot fill it; pass `type(uint96).max` (buy) or `0` (sell) for no limit. `minAmountOut` is the minimum base amount filled; the transaction reverts with `SlippageExceeded` if less fills. Whatever does not fill is returned; with no liquidity within the limit, the order fills nothing and, unless `minAmountOut` is set, does not revert.

### Matching Engine Details

The matching engine runs inline during order placement. When a new order crosses the spread, the engine walks the opposite side of the book starting from the best price:

1. For each price level, it dequeues orders in FIFO order (earliest first)
2. Each fill transfers tokens between the maker and taker. Buy orders always execute at the **ask price** (the maker's price), so buyers may get a better price than their limit
3. If a buy order fills at a price lower than its limit, the excess quote tokens are refunded to the buyer immediately
4. The engine stops after **6 fills** (`MAX_FILLS_PER_TX`): each fill needs about 1 MB of proof, and one transaction may use 8 MiB on Asset Hub. If the incoming order still has remaining amount, it rests on the book at its limit price; a market order returns it
5. Expired orders encountered during the walk are skipped and lazily removed; each one counts toward the 6-fill cap, so a backlog of expired orders cannot make one transaction's work unbounded. `purgeExpired(side, price, maxOrders)` removes expired orders at one price level in bounded batches

### Self-Trade Prevention

The DLOB prevents wash trading by checking both `msg.sender` (the EVM caller) and `originAccount` (the Substrate AccountId32 passed as a parameter). If an incoming order would match against a resting order from the same owner **and** the same origin account, the transaction reverts with `SelfTrade`. This allows the same trader to legitimately hold orders on both sides from different origin accounts (e.g., different parachains).

### Order Management

Beyond placement and cancellation, the DLOB supports:

- **`reduceOrder()`:** Shrink a resting order's amount without cancelling it, keeping its place in the FIFO queue. If the new amount falls below `minOrderSize`, the order is cancelled automatically instead.
- **`batchCancelOrders()`:** Cancel multiple orders in a single transaction to save gas.
- **`redirectClaim()`:** Change the destination parachain of a `PendingClaim` before settling it. Useful if the original destination is unreachable. The beneficiary stays the order's settlement account; only `adminRedirectClaim()` can change it.

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

Asset Hub manages two categories of assets, each with its own pallet and ERC20 precompile prefix:

1. **Trust-backed assets** are tokens issued directly on Asset Hub by a trusted admin (an account or governance body). The admin creates the asset via `pallet-assets`, sets metadata, and controls minting. Examples include USDT (asset ID 1984) and USDC (asset ID 1337), where Tether and Circle respectively are the trusted issuers. These use ERC20 precompile prefix `0x0120`, and their XCM Location can be derived deterministically from the asset ID. When creating a market with a trust-backed asset, leave the `xcmLocation` field empty in `TokenConfig`.

2. **Foreign assets** are tokens that originate from other consensus systems (Ethereum, Kusama, other parachains) and are bridged onto Asset Hub. They are registered via the `ForeignAssets` pallet, typically through governance, and identified by their XCM Location (e.g., `GlobalConsensus(Ethereum) / AccountKey20(0xC02a...)` for WETH). Examples include bridged WETH, WBTC, and KSM. These use ERC20 precompile prefix `0x0220`, with sequential indices assigned automatically by `pallet-assets-precompiles` at registration time. When creating a market with a foreign asset, provide the SCALE-encoded XCM Location in the `xcmLocation` field of `TokenConfig`. The contract cannot derive this on-chain because the precompile address only contains the u32 index, and the index-to-location mapping lives in substrate storage (inaccessible from Solidity). See [Configuring XCM Locations](#configuring-xcm-locations) below.

**User-deployed ERC20 contracts** are not supported, even though they implement the same IERC20 interface. An ERC20 precompile is not a deployed contract. It is a synthetic address provided by the runtime that reads and writes `pallet-assets` storage directly. Calling `transfer()` on a precompile updates the same balances that XCM reads and writes. A user-deployed ERC20, in contrast, stores balances in its own contract storage, invisible to the runtime and the XCM executor. Because cross-chain settlement relies on XCM, which can only move assets the runtime knows about, only precompile-backed tokens can participate. Even for local-only orders, the DLOB uses the same precompile interface for consistency.

### Configuring XCM Locations

Markets are created via `DLOBFactory.createMarket()`, which only the factory admin can call. It takes a `TokenConfig` struct for each token:

```solidity
struct TokenConfig {
    address token;       // ERC20 precompile address
    bytes xcmLocation;   // SCALE-encoded XCM Location (empty for trust-backed assets)
}
```

**Trust-backed assets** (prefix `0x0120`): leave `xcmLocation` empty; the factory rejects a location for them. The contract derives the location automatically:

```
Location { parents: 0, interior: X2(PalletInstance(50), GeneralIndex(assetId)) }
```

where `assetId` is extracted from the upper 4 bytes of the precompile address. For example, USDT on Asset Hub has asset ID 1984 and precompile address `0x000007C0000000000000000000000000001200000` (truncated); the contract reads `0x000007C0` = 1984 and builds the location on-chain.

**Foreign assets** (prefix `0x0220`): provide the SCALE-encoded `xcmLocation`. This is the XCM `Location` that the Asset Hub runtime uses to identify the asset. The contract stores it as-is and uses it verbatim for cross-chain settlement XCM messages.

To obtain the correct SCALE-encoded location for a foreign asset:

1. **Query the runtime.** On Asset Hub, the storage map `ForeignAssets::AssetIdOf` (or `AssetIndexToForeignAssetId`) maps the u32 index to an XCM `Location`. Use the Polkadot.js Apps storage query or `subxt` to read the location for your asset.

2. **SCALE-encode the Location.** The `xcmLocation` bytes must be the SCALE encoding of the `xcm::v5::Location` struct, which is `(parents: u8, interior: Junctions)`. For example, WETH bridged from Ethereum through Snowbridge has:
   ```
   Location {
       parents: 2,
       interior: X2(
           GlobalConsensus(Ethereum { chain_id: 1 }),
           AccountKey20 { network: None, key: 0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2 }
       )
   }
   ```
   The SCALE encoding of this location is what goes into the `xcmLocation` field.

3. **Verify before deploying.** The contract cannot validate that a foreign asset location is correct. An incorrect location will cause cross-chain settlement to fail (the XCM executor will not find the asset) or, worse, deliver the wrong asset. Always test with a small market on a testnet first.

For trust-backed assets, no manual encoding is needed; the contract derives the location on-chain.

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

If a destination chain becomes unreachable (e.g., HRMP channel closed), the claim owner can call `redirectClaim(claimId, originAccount, newDestParaId)` to reroute delivery to a different parachain, for the same beneficiary. The factory admin can also redirect any claim, including its beneficiary, via `adminRedirectClaim()` as a safety measure.

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
