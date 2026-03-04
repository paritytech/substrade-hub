# SubsTrade Hub

A fully on-chain **Decentralized Limit Order Book** for [Polkadot Asset Hub](https://docs.polkadot.com/smart-contracts/), built with Solidity on [pallet-revive](https://docs.polkadot.com/smart-contracts/overview/revive/) and cross-chain settlement via [XCM](https://docs.polkadot.com/polkadot-protocol/basics/interoperability/).

## What is a DLOB?

A **Decentralized Limit Order Book (DLOB)** is a trading mechanism where buyers and sellers submit orders at specific prices, and a matching engine pairs them together — all running on-chain with no centralized intermediary.

Unlike AMMs (Automated Market Makers) that use liquidity pools and bonding curves, a DLOB works like a traditional exchange order book:

- **Buyers** post bids: "I want to buy 100 tokens at $1.50 each"
- **Sellers** post asks: "I want to sell 200 tokens at $1.55 each"
- When a bid price meets or exceeds an ask price, the **matching engine** fills the trade
- Unfilled orders **rest on the book** until matched, cancelled, or expired

This gives traders precise control over execution price, supports true price discovery, and avoids the slippage and impermanent loss inherent in AMM designs.

## How It Works

### Order Lifecycle

1. **Place** — A trader submits a limit order (buy or sell) with a price and amount. The order book escrows the relevant tokens (base for sells, quote for buys) and inserts the order at the correct price level.

2. **Match** — When a new order crosses the spread (bid >= ask), the matching engine fills orders in **price-time priority** (best price first, then FIFO within each price level). A single transaction can execute up to 50 fills.

3. **Settle** — Matched tokens are delivered to the counterparties. For local (Asset Hub) traders, this is a direct token transfer. For cross-chain traders, settlement uses XCM reserve transfers to deliver tokens to the destination parachain.

4. **Cancel / Expire** — Unfilled orders can be cancelled by the owner at any time. Orders with an expiry timestamp are lazily cleaned during matching — no keeper or cron job needed.

### Cross-Chain Flow

All tokens in the order book are **Asset Hub native assets** (pallet-assets). Traders on **any Polkadot parachain** can place and settle orders without leaving their home chain — XCM handles the token movement:

```
Parachain A                    Asset Hub                     Parachain B
(Buyer)                     (Order Book)                     (Seller)
    │                            │                               │
    │── XCM: quote tokens ─────>│                               │
    │   + placeLimitOrder(buy)   │                               │
    │                            │<── XCM: base tokens ─────────│
    │                            │    + placeLimitOrder(sell)    │
    │                            │                               │
    │                       [matching]                           │
    │                            │                               │
    │<── XCM: base tokens ──────│                               │
    │   (settlement delivery)    │── XCM: quote tokens ────────>│
    │                            │   (settlement delivery)      │
```

The buyer sends quote tokens (e.g., USDT) to Asset Hub and receives base tokens (e.g., [XAUT](https://gold.tether.to/) — Tether Gold, a tokenized gold asset) after matching. The seller does the opposite. Any pallet-asset on Asset Hub can be traded — the order book is token-agnostic.

### Placing an Order from Another Parachain

The DLOB contract lives on Asset Hub and accepts calls from any origin. Traders on other parachains interact with it via **XCM `Transact`**, which calls `pallet_revive::call()` — the Substrate extrinsic for invoking EVM contracts with a native value transfer.

A user on Parachain A signs **one extrinsic** on their home chain. This sends an XCM program to Asset Hub that deposits tokens, approves the DLOB, and places the order atomically:

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
   • originAccount     — user's AccountId32 (self-trade prevention)
   • settlementAccount — where to deliver matched tokens on home chain
   • destParaId        — home parachain ID (e.g., 1004 for People Chain)
```

The user never manages an Asset Hub account directly. Tokens flow through a derived account during XCM execution and end up escrowed in the DLOB — all in one atomic operation.

### Settlement Delivery

When a cross-chain order is filled, the DLOB automatically sends matched tokens to the trader's `settlementAccount` on `destParaId` via an XCM reserve transfer. The DOT fee reserve (sent as `msg.value` with the order) covers the XCM execution cost.

### Fee Reserve

Each cross-chain order must include a DOT fee reserve (`msg.value >= factory.minCrossChainFee()`). This reserve pays for XCM settlement delivery when the order is filled. If an order is cancelled before being filled, the fee reserve is returned via XCM to the user's home chain.

### PendingClaim Fallback

If inline XCM settlement fails (e.g., destination chain is congested, HRMP channel full), a `PendingClaim` is created instead. Funds remain safe on Asset Hub — anyone can call `claimSettlement(claimId)` later to retry the XCM delivery. No funds are ever lost.

### Destination Chain Requirements

For a parachain to receive settlement tokens from the DLOB:

1. **HRMP channel** — Open channel between Asset Hub and the destination parachain
2. **Asset recognition** — The destination chain must accept the traded asset as a reserve-backed foreign asset from Asset Hub (via a foreign assets pallet or XCM `AssetTransactor`)
3. **XCM barriers** — The chain's XCM configuration must permit reserve transfers from Asset Hub

Most Polkadot parachains already accept common Asset Hub tokens. If the destination chain does not recognize a specific asset, the inline XCM will fail and a PendingClaim is created — funds remain safe on Asset Hub until delivery can be retried or redirected via `claimRedirect()`.

## Key Features

- **Red-Black Tree order book** — O(log n) price level insert/remove with best bid/ask tracking
- **FIFO matching** — Price-time priority within each level, up to 50 fills per transaction
- **Cross-chain settlement** — XCM reserve transfers to any parachain; DOT fee reserve per order
- **Pending claim fallback** — If inline XCM fails, a `PendingClaim` is created for later retry by anyone
- **Limit and market orders** — `placeLimitOrder()` with optional expiry, `placeMarketOrder()` with slippage protection
- **Order management** — Cancel, batch cancel, reduce-only, claim redirect
- **Lazy expiry** — Expired orders cleaned during matching, no keeper needed
- **Self-trade prevention** — Same owner + same origin account reverts

## Prerequisites

Install [Foundry for Polkadot](https://github.com/paritytech/foundry-polkadot):

```bash
curl -L https://raw.githubusercontent.com/paritytech/foundry-polkadot/refs/heads/master/foundryup/install | bash
foundryup
```

This fork of Foundry adds support for testing against [pallet-revive](https://docs.polkadot.com/smart-contracts/overview/revive/) (the actual Polkadot smart contract runtime) via the `--polkadot` flag.

Get testnet WND tokens from the [Westend faucet](https://faucet.polkadot.io/westend) to pay for gas on Asset Hub Westend.

See the [Foundry for Polkadot docs](https://docs.polkadot.com/smart-contracts/dev-environments/foundry/) for details.

## Build

```bash
forge build
```

The project compiles with Solc 0.8.28, EVM target `prague`, and `via_ir = true` (required due to contract size). See `foundry.toml` for full config.

## Test

Run tests against pallet-revive (the actual Polkadot smart contract runtime):

```bash
forge test --polkadot
```

This uses the pallet-revive EVM backend, so tests execute in the same runtime as production. You can also run against standard Anvil (without `--polkadot`) for faster iteration during development.

Run with gas reporting:

```bash
forge test --gas-report
```

Run a specific test file:

```bash
forge test --polkadot --match-path test/Matching.t.sol -vv
```

Run invariant tests (takes ~30 min):

```bash
forge test --match-test "invariant_" -vv
```

### Test Suite

| File | Tests | Coverage |
|---|---|---|
| `DLOB.t.sol` | 30 | Order placement, cancellation, reduction, matching, expiry, views, admin |
| `DLOBFactory.t.sol` | 12 | Market creation, duplicate prevention, admin config |
| `Matching.t.sol` | 10 | Multi-level fills, market orders, max fills cap, self-trade, slippage |
| `CrossChain.t.sol` | 21 | Inline XCM, claim fallback, fee reserve lifecycle, claim redirect |
| `GasReport.t.sol` | 12 | Gas benchmarks for all core operations |
| `DLOB.fuzz.t.sol` | 15 | 7 fuzz tests (257 runs) + 8 stateful invariants (128k calls each) |

## Deploy

Create a `.env` file (already in `.gitignore`):

```
PRIVATE_KEY=your_private_key_here
```

Then load it:

```bash
source .env
```

On Asset Hub, the precompile addresses are:
- **XCM**: `0x0000000000000000000000000000000000A0000`
- **System**: `0x0000000000000000000000000000000000000900`

### Testnet (Asset Hub Westend)

Deploy in three steps: library, implementation, then factory.

```bash
# 1. Deploy RedBlackTree library
forge create src/libraries/RedBlackTree.sol:RedBlackTree \
    --chain polkadot-testnet \
    --private-key $PRIVATE_KEY \
    --broadcast

# 2. Deploy DLOB implementation (linked to library)
forge create src/DLOB.sol:DLOB \
    --libraries src/libraries/RedBlackTree.sol:RedBlackTree:<LIBRARY_ADDRESS> \
    --chain polkadot-testnet \
    --private-key $PRIVATE_KEY \
    --broadcast

# 3. Deploy DLOBFactory (with XCM precompile, System precompile, and DLOB implementation)
forge create src/DLOBFactory.sol:DLOBFactory \
    --constructor-args 0x0000000000000000000000000000000000A0000 0x0000000000000000000000000000000000000900 <DLOB_IMPL_ADDRESS> \
    --chain polkadot-testnet \
    --private-key $PRIVATE_KEY \
    --broadcast
```

### Mainnet (Polkadot Asset Hub)

```bash
# 1. Deploy RedBlackTree library
forge create src/libraries/RedBlackTree.sol:RedBlackTree \
    --chain polkadot \
    --private-key $PRIVATE_KEY \
    --broadcast

# 2. Deploy DLOB implementation (linked to library)
forge create src/DLOB.sol:DLOB \
    --libraries src/libraries/RedBlackTree.sol:RedBlackTree:<LIBRARY_ADDRESS> \
    --chain polkadot \
    --private-key $PRIVATE_KEY \
    --broadcast

# 3. Deploy DLOBFactory
forge create src/DLOBFactory.sol:DLOBFactory \
    --constructor-args 0x0000000000000000000000000000000000A0000 0x0000000000000000000000000000000000000900 <DLOB_IMPL_ADDRESS> \
    --chain polkadot \
    --private-key $PRIVATE_KEY \
    --broadcast
```

### Creating a Market

After deploying the factory, create a new order book:

```bash
cast send <FACTORY_ADDRESS> \
    "createMarket(address,address,uint96,uint96,uint128)" \
    <BASE_TOKEN> <QUOTE_TOKEN> <TICK_SIZE> <MIN_ORDER_SIZE> <MAX_ORDER_SIZE> \
    --chain polkadot-testnet \
    --private-key $PRIVATE_KEY
```

### Interacting with the Contract

Read the admin address:

```bash
cast call <FACTORY_ADDRESS> "admin()(address)" --chain polkadot-testnet
```

Check your account balance:

```bash
cast balance $ACCOUNT_ADDRESS --chain polkadot-testnet
```

### Verify

Verify on Blockscout (no API key needed):

```bash
forge verify-contract <LIBRARY_ADDRESS> src/libraries/RedBlackTree.sol:RedBlackTree \
    --chain polkadot-testnet

forge verify-contract <DLOB_IMPL_ADDRESS> src/DLOB.sol:DLOB \
    --libraries src/libraries/RedBlackTree.sol:RedBlackTree:<LIBRARY_ADDRESS> \
    --chain polkadot-testnet

forge verify-contract <FACTORY_ADDRESS> src/DLOBFactory.sol:DLOBFactory \
    --chain polkadot-testnet
```

## Architecture

```
RedBlackTree (deployed library, ~6KB)
  └── delegatecall from DLOB for O(log n) tree operations

DLOBFactory (~2KB)
  └── creates EIP-1167 minimal proxy clones of DLOB implementation
        └── DLOB clone (~45 bytes proxy → delegates to implementation)
              ├── RedBlackTree library (bid + ask price levels, O(log n))
              ├── FIFO Order Queue (per price level, doubly-linked list)
              ├── Matching Engine (up to 50 fills per tx)
              └── XCM Settlement (inline or pending claim fallback)
```

The architecture uses two patterns to stay within the EIP-170 contract size limit (24KB) enforced by pallet-revive:

- **External library** — The Red-Black Tree (~6KB bytecode) is deployed separately and called via `delegatecall`, keeping it out of DLOB's runtime code.
- **EIP-1167 clones** — Each market is a minimal proxy (~45 bytes) that delegates to a single DLOB implementation, so DLOBFactory doesn't embed DLOB's creation bytecode.

### Contracts

| Contract | Description |
|---|---|
| `DLOB.sol` | Core order book — placement, matching, settlement, cancellation. Deployed once as implementation; cloned per market. |
| `DLOBFactory.sol` | Market registry — creates EIP-1167 clones of DLOB, manages global config |

### Libraries

| Library | Description |
|---|---|
| `RedBlackTree.sol` | Deployed library for red-black tree operations (insert, remove, min, max, successor, predecessor) |
| `PriceMath.sol` | Tick alignment, quote amount calculation (floor and ceil) |
| `XcmBuilder.sol` | Builds XCM V5 dual-asset reserve transfer messages |
| `ScaleCodec.sol` | SCALE encoding for Substrate types |

### Interfaces

| Interface | Description |
|---|---|
| `IXcm.sol` | XCM precompile — `execute()`, `weighMessage()`, `send()` |
| `ISystem.sol` | System precompile — Blake2 hashing, account conversion |
| `IDLOBFactory.sol` | Factory interface for DLOB instances |

## Configuration

Key parameters set at market creation:

| Parameter | Type | Description |
|---|---|---|
| `tickSize` | `uint96` | Minimum price increment |
| `minOrderSize` | `uint96` | Minimum order amount |
| `maxOrderSize` | `uint128` | Maximum order amount |

Global parameters (admin-configurable on factory):

| Parameter | Default | Description |
|---|---|---|
| `minCrossChainFee` | — | Minimum DOT per XCM settlement leg |
| `marketCreationDeposit` | 0 | Optional DOT deposit to create a market |

## Networks

| Network | RPC | Chain ID |
|---|---|---|
| Paseo Asset Hub (testnet) | `https://services.polkadothub-rpc.com/testnet/` | 420420417 |
| Polkadot Asset Hub | `https://services.polkadothub-rpc.com/mainnet` | 420420419 |
| Kusama Asset Hub | `https://kusama-asset-hub-eth-rpc.polkadot.io` | 420420418 |

## Documentation

- [Polkadot Smart Contracts](https://docs.polkadot.com/smart-contracts/)
- [Foundry for Polkadot](https://docs.polkadot.com/smart-contracts/dev-environments/foundry/)
- [XCM Documentation](https://docs.polkadot.com/polkadot-protocol/basics/interoperability/)
- [pallet-revive](https://docs.polkadot.com/smart-contracts/overview/revive/)

## License

GPL-3.0-only — see [LICENSE](LICENSE) for details.
