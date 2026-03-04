# SubsTrade Hub

A fully on-chain **Decentralized Limit Order Book** for [Polkadot Asset Hub](https://docs.polkadot.com/smart-contracts/), built with Solidity on [pallet-revive](https://docs.polkadot.com/polkadot-protocol/smart-contract-basics/) and cross-chain settlement via [XCM](https://docs.polkadot.com/parachains/interoperability/get-started/).

## What is a DLOB?

A **Decentralized Limit Order Book (DLOB)** is a trading mechanism where buyers and sellers submit orders at specific prices, and a matching engine pairs them together — all running on-chain with no centralized intermediary.

Unlike AMMs (Automated Market Makers) that use liquidity pools and bonding curves, a DLOB works like a traditional exchange order book:

- **Buyers** post bids: "I want to buy 100 tokens at $1.50 each"
- **Sellers** post asks: "I want to sell 200 tokens at $1.55 each"
- When a bid price meets or exceeds an ask price, the **matching engine** fills the trade
- Unfilled orders **rest on the book** until matched, cancelled, or expired

This gives traders precise control over execution price, supports true price discovery, and avoids the slippage and impermanent loss inherent in AMM designs.

```
                          Order Book: XAUT / USDT

  BIDS (buyers) - qty            | Price      | ASKS (sellers) - qty
  ───────────────────────────────|────────────|──────────────────────────────────────
  ██████  3                      | $5,147.50  |
  ████████████  6                | $5,147.75  |
  ██████████████████  9          | $5,148.00  |
  ████████████████████████  12   | $5,148.25  |
                                 | ─spread──  |
                                 | $5,148.50  | 10 ████████████████████
                                 | $5,148.75  | 7  ██████████████
                                 | $5,149.00  | 4  ████████
                                 | $5,149.50  | 2  ████

```

**Best Bid:** $5,148.25 · **Best Ask:** $5,148.50 · **Spread:** $0.25

- Limit buy at $5,148.50 → fills against the best ask immediately
- Limit buy at $5,147.00 → rests on the bid side until a seller matches
- Market buy for 8 XAUT → sweeps the best asks ($5,148.50, then $5,148.75)

## How It Works

### Order Lifecycle

1. **Place** — A trader submits a limit order (buy or sell) with a price and amount. The order book escrows the relevant tokens (base for sells, quote for buys) and inserts the order at the correct price level.
2. **Match** — When a new order crosses the spread (bid >= ask), the matching engine fills orders in **price-time priority** (best price first, then FIFO within each price level). A single transaction can execute up to 50 fills.
3. **Settle** — Matched tokens are delivered to the counterparties. For local (Asset Hub) traders, this is a direct token transfer. For cross-chain traders, settlement uses XCM reserve transfers to deliver tokens to the destination parachain.
4. **Cancel / Expire** — Unfilled orders can be cancelled by the owner at any time. Orders with an expiry timestamp are lazily cleaned during matching — no keeper or cron job needed.

### Cross-Chain Flow

All tokens in the order book are **Asset Hub native assets** (pallet-assets). Traders on **any Polkadot parachain** can place and settle orders without leaving their home chain — XCM handles the token movement:

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

The buyer sends quote tokens (e.g., USDT) to Asset Hub and receives base tokens (e.g., [XAUT](https://gold.tether.to/) — Tether Gold, a tokenized gold asset) after matching. The seller does the opposite. Any asset registered on Asset Hub via `pallet-assets` can be traded — each asset is accessible as an ERC20 through a deterministic [precompile address](https://docs.polkadot.com/smart-contracts/precompiles/erc20/).

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
   • destParaId        — home parachain ID (e.g., 2034 for Hydration)
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

Most Polkadot parachains already accept common Asset Hub tokens. Parachains with active HRMP channels to Asset Hub that can receive settled tokens include:

- **[Hydration](https://hydration.net/)** (2034) — DEX and liquidity hub, the most active cross-chain destination from Asset Hub
- **[Moonbeam](https://moonbeam.network/)** (2004) — EVM-compatible smart contract platform with a broad DeFi ecosystem
- **[Bifrost](https://bifrost.io/)** (2030) — Liquid staking protocol supporting DOT and other assets

> **Note:** Cross-chain settlement depends on the destination chain's runtime configuration, HRMP channel health, and asset registration. Parachains may upgrade their runtime, close channels, or stop accepting certain assets at any time. If delivery fails for any reason, a `PendingClaim` is created — funds remain safe on Asset Hub and can be retried via `claimSettlement()` or redirected to a different destination via `redirectClaim()`.

## Key Features

- **Red-Black Tree price levels** — Bid and ask prices are stored in a red-black tree for O(log n) insert/remove and O(1) best bid/ask lookup
- **Price-time priority matching** — Orders fill at the best available price first; within the same price level, earlier orders fill before later ones (FIFO). Up to 50 fills per transaction
- **Cross-chain settlement via XCM** — Matched tokens are delivered to any Polkadot parachain using XCM reserve transfers. Each cross-chain order includes a DOT fee reserve to cover delivery costs
- **Pending claim fallback** — If inline XCM delivery fails (e.g., destination chain congested), a `PendingClaim` is created. Anyone can call `claimSettlement()` later to retry — no funds are lost
- **Limit and market orders** — `placeLimitOrder()` rests on the book with optional expiry; `placeMarketOrder()` fills immediately with slippage protection (`minAmountOut`)
- **Order management** — Cancel, batch cancel, reduce-only (shrink an order without cancelling), and claim redirect (change settlement destination)
- **Lazy expiry** — Orders with an expiry timestamp are cleaned during matching when encountered — no off-chain keeper or cron job needed
- **Self-trade prevention** — Matching reverts if both sides share the same owner address and origin account, preventing wash trading

## Prerequisites

Install [Foundry for Polkadot](https://github.com/paritytech/foundry-polkadot):

```bash
curl -L https://raw.githubusercontent.com/paritytech/foundry-polkadot/refs/heads/master/foundryup/install | bash
foundryup
```

This fork of Foundry adds support for testing against [pallet-revive](https://docs.polkadot.com/polkadot-protocol/smart-contract-basics/) (the actual Polkadot smart contract runtime) via the `--polkadot` flag.

Get testnet PAS tokens from the [Paseo faucet](https://faucet.polkadot.io/) to pay for gas on Paseo Asset Hub.

See the [Foundry for Polkadot docs](https://github.com/paritytech/foundry-polkadot) for details.

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


| File                | Tests | Coverage                                                                 |
| ------------------- | ----- | ------------------------------------------------------------------------ |
| `DLOB.t.sol`        | 32    | Order placement, cancellation, reduction, matching, expiry, depth integrity, views, admin |
| `DLOBFactory.t.sol` | 17    | Market creation, duplicate prevention, parameter validation, admin config |
| `Matching.t.sol`    | 15    | Multi-level fills, market orders, max fills cap, self-trade, slippage, buyer refunds, pull validation |
| `CrossChain.t.sol`  | 25    | Inline XCM, claim fallback, fee reserve lifecycle, claim redirect, XCM failure recovery |
| `GasReport.t.sol`   | 12    | Gas benchmarks for all core operations                                   |
| `DLOB.fuzz.t.sol`   | 15    | 7 fuzz tests (257 runs) + 8 stateful invariants (128k calls each)        |


## Deploy

Deployment is a two-step process:

1. **Deploy infrastructure** — Run the `DeployFactory` forge script, which deploys the DLOB implementation contract and the DLOBFactory in a single broadcast. Forge automatically deploys the RedBlackTree external library (referenced via `delegatecall` by DLOB) and links it into the bytecode — no need to deploy the library separately or pass `--libraries` flags manually.
2. **Create markets** — Call `createMarket()` on the factory with `cast send` for each trading pair. Each market is an EIP-1167 minimal proxy clone of the DLOB implementation.

Copy the example environment file and fill in your deployer key and RPC URL:

```bash
cp .env.example .env
```

The root `.env.example` contains only what's needed for deployment — deployer key, network config, and contract addresses.

### Deploy Factory

The `DeployFactory` script deploys the full stack (DLOB implementation + DLOBFactory) in a single transaction:

```bash
# Testnet (Paseo Asset Hub)
forge script script/DeployFactory.s.sol \
    --chain polkadot-testnet \
    --private-key $DEPLOYER_PRIVATE_KEY \
    --broadcast

# Mainnet (Polkadot Asset Hub)
forge script script/DeployFactory.s.sol \
    --chain polkadot \
    --private-key $DEPLOYER_PRIVATE_KEY \
    --broadcast
```

The script logs deployed addresses to the console. Full transaction receipts are saved to `broadcast/DeployFactory.s.sol/<chainId>/run-latest.json`.

### Create Market

Token addresses are ERC20 precompile addresses derived from the pallet-asset ID:

```
ERC20 address = 0x<assetId hex, 8 chars>00000000000000000000000001200000
```

For example, USDT (asset 1984 = `0x000007c0`) → `0x000007c000000000000000000000000001200000`.

Use `cast send` to create a market on the deployed factory:

```bash
cast send <FACTORY_ADDRESS> \
    "createMarket(address,address,uint96,uint96,uint128)" \
    <BASE_ERC20> <QUOTE_ERC20> \
    <TICK_SIZE> <MIN_ORDER_SIZE> <MAX_ORDER_SIZE> \
    --chain polkadot-testnet \
    --private-key $DEPLOYER_PRIVATE_KEY
```

Example: XAUT/USDT market (both 6 decimals), tick size $0.01, min 0.001 XAUT, max 1000 XAUT:

```bash
cast send 0x... \
    "createMarket(address,address,uint96,uint96,uint128)" \
    0x...XAUT 0x000007c000000000000000000000000001200000 \
    10000000000000000 1000 1000000000 \
    --chain polkadot-testnet \
    --private-key $DEPLOYER_PRIVATE_KEY
```

Where `10000000000000000` = 0.01 × 10¹⁸ (tick), `1000` = 0.001 × 10⁶ (min), `1000000000` = 1000 × 10⁶ (max).

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
forge verify-contract <DLOB_IMPL_ADDRESS> src/DLOB.sol:DLOB \
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


| Contract          | Description                                                                                                          |
| ----------------- | -------------------------------------------------------------------------------------------------------------------- |
| `DLOB.sol`        | Core order book — placement, matching, settlement, cancellation. Deployed once as implementation; cloned per market. |
| `DLOBFactory.sol` | Market registry — creates EIP-1167 clones of DLOB, manages global config                                             |


### Libraries


| Library            | Description                                                                                       |
| ------------------ | ------------------------------------------------------------------------------------------------- |
| `RedBlackTree.sol` | Deployed library for red-black tree operations (insert, remove, min, max, successor, predecessor) |
| `PriceMath.sol`    | Tick alignment, quote amount calculation (floor and ceil)                                         |
| `XcmBuilder.sol`   | Builds XCM V5 dual-asset reserve transfer messages                                                |
| `ScaleCodec.sol`   | SCALE encoding for Substrate types                                                                |


### Interfaces


| Interface          | Description                                              |
| ------------------ | -------------------------------------------------------- |
| `IXcm.sol`         | XCM precompile — `execute()`, `weighMessage()`, `send()` |
| `ISystem.sol`      | System precompile — Blake2 hashing, account conversion   |
| `IDLOBFactory.sol` | Factory interface for DLOB instances                     |


## Configuration

### Market Parameters

Each market is created with three parameters that control price precision and order sizing.
All values are integers — no floating-point. Prices use **18-decimal fixed-point**; amounts use the **base token's native decimals**.


| Parameter      | Type      | Unit                   | Description                                                                |
| -------------- | --------- | ---------------------- | -------------------------------------------------------------------------- |
| `tickSize`     | `uint96`  | 18-decimal fixed-point | Minimum price increment. All limit prices must be multiples of this value. |
| `minOrderSize` | `uint96`  | Base token raw units   | Smallest allowed order amount. Orders below this are rejected.             |
| `maxOrderSize` | `uint128` | Base token raw units   | Largest allowed order amount. Orders above this are rejected.              |


**Example — XAUT/USDT market** (both tokens have 6 decimals):


| Parameter      | Human value | Raw value           | Calculation |
| -------------- | ----------- | ------------------- | ----------- |
| `tickSize`     | $0.01       | `10000000000000000` | 0.01 × 10¹⁸ |
| `minOrderSize` | 0.001 XAUT  | `1000`              | 0.001 × 10⁶ |
| `maxOrderSize` | 1,000 XAUT  | `1000000000`        | 1000 × 10⁶  |


> **Why 18 decimals for price?** Prices are stored in 18-decimal fixed-point regardless of the tokens' native decimals. This ensures uniform precision across all markets and avoids rounding errors for tokens with few decimals.

### Factory Parameters

Global parameters configurable by the factory admin after deployment:


| Parameter               | Default | Unit               | Description                                                                                 |
| ----------------------- | ------- | ------------------ | ------------------------------------------------------------------------------------------- |
| `minCrossChainFee`      | —       | DOT (native units) | Minimum DOT attached per XCM settlement leg. Covers execution fees on the remote parachain. |
| `marketCreationDeposit` | 0       | DOT (native units) | Optional deposit required to create a new market. Set to 0 to allow free market creation.   |


### Trading with DOT

DOT is the native token on Asset Hub and is not registered in `pallet-assets`, so it doesn't have an ERC20 precompile address. To use DOT in a market, wrap it into an ERC20 via a simple **Wrapped DOT (WDOT)** contract — the same pattern Ethereum uses with WETH.

A basic WDOT contract would expose two functions: `deposit()` accepts native DOT and mints an equal amount of WDOT tokens, and `withdraw()` burns WDOT and returns native DOT. The contract is stateless beyond the standard ERC20 balance mapping, making it easy to audit and trust. Note that deploying and registering a canonical WDOT token on Asset Hub may require a governance proposal.

Once available, WDOT can be used as the base or quote token in any market. For example, a **WDOT/USDT** market lets traders place DOT-denominated orders with USDT settlement.

## Networks


| Network                   | RPC                                             | Chain ID  |
| ------------------------- | ----------------------------------------------- | --------- |
| Paseo Asset Hub (testnet) | `https://services.polkadothub-rpc.com/testnet/` | 420420417 |
| Polkadot Asset Hub        | `https://services.polkadothub-rpc.com/mainnet`  | 420420419 |
| Kusama Asset Hub          | `https://kusama-asset-hub-eth-rpc.polkadot.io`  | 420420418 |


## Documentation

- [Polkadot Smart Contracts](https://docs.polkadot.com/smart-contracts/)
- [Foundry for Polkadot](https://github.com/paritytech/foundry-polkadot)
- [XCM Documentation](https://docs.polkadot.com/parachains/interoperability/get-started/)
- [pallet-revive](https://docs.polkadot.com/polkadot-protocol/smart-contract-basics/)

## License

GPL-3.0-only — see [LICENSE](LICENSE) for details.
