[← Back to README](../README.md)

# Deployment Guide

Deployment is a two-step process:

1. **Deploy infrastructure.** Run the `DeployFactory` forge script, which deploys the DLOB implementation contract and the DLOBFactory in a single broadcast. Forge automatically deploys the RedBlackTree external library (referenced via `delegatecall` by DLOB) and links it into the bytecode; no need to deploy the library separately or pass `--libraries` flags manually.
2. **Create markets.** Call `createMarket()` on the factory with `cast send` for each trading pair. Each market is an EIP-1167 minimal proxy clone of the DLOB implementation.

## Environment Setup

Copy the example environment file and fill in your deployer key and RPC URL:

```bash
cp .env.example .env
```

The `.env.example` contains:

| Variable               | Description                                              |
| ---------------------- | -------------------------------------------------------- |
| `DEPLOYER_PRIVATE_KEY` | ECDSA private key for the deployer account               |
| `RPC_URL`              | Network RPC endpoint                                     |
| `CHAIN_ID`             | Chain ID (`420420417` for Paseo, `420420419` for mainnet) |
| `DLOB_IMPL_ADDRESS`   | Filled after deployment: the DLOB implementation address  |
| `DLOB_FACTORY_ADDRESS` | Filled after deployment: the DLOBFactory address         |
| `XCM_PRECOMPILE`       | Fixed: `0x00000000000000000000000000000000000A0000`       |
| `SYSTEM_PRECOMPILE`    | Fixed: `0x0000000000000000000000000000000000000900`       |

Get testnet PAS tokens from the [Paseo faucet](https://faucet.polkadot.io/) to pay for gas on Paseo Asset Hub.

## Deploy Factory

The `DeployFactory` script deploys the full stack in a single broadcast:

1. Deploys the **RedBlackTree** (~6KB) and **XcmBuilder** (~3KB) external libraries. Forge detects the library linkages in the bytecode and deploys them automatically.
2. Deploys the **DLOB implementation** contract with both libraries linked.
3. Deploys the **DLOBFactory** with the XCM precompile, System precompile, and DLOB implementation addresses.

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

The script logs deployed addresses to the console. Save these to your `.env` file:

```
DLOB_IMPL_ADDRESS=0x...
DLOB_FACTORY_ADDRESS=0x...
```

Full transaction receipts are saved to `broadcast/DeployFactory.s.sol/<chainId>/run-latest.json`.

### Post-Deployment Setup

After deploying, configure the factory's global parameters:

```bash
# Set minimum cross-chain fee (DOT in Planck units, 1 DOT = 10^10 Planck)
cast send $DLOB_FACTORY_ADDRESS \
    "setMinCrossChainFee(uint128)" \
    <FEE_IN_PLANCK> \
    --chain polkadot-testnet \
    --private-key $DEPLOYER_PRIVATE_KEY

# Optionally set a market creation deposit
cast send $DLOB_FACTORY_ADDRESS \
    "setMarketCreationDeposit(uint128)" \
    <DEPOSIT_IN_PLANCK> \
    --chain polkadot-testnet \
    --private-key $DEPLOYER_PRIVATE_KEY
```

See [configuration](configuration.md) for details on these parameters.

## Create Market

### Token Address Derivation

Token addresses on Asset Hub are ERC20 precompile addresses derived deterministically from the asset's pallet index.

**Trust-backed assets** (pallet-assets, prefix `0x0120`):

```
ERC20 address = 0x<assetId hex, 8 chars>00000000000000000000000001200000
```

| Asset       | Asset ID | Hex        | ERC20 Precompile Address                       |
| ----------- | -------- | ---------- | ---------------------------------------------- |
| USDT        | 1984     | `000007c0` | `0x000007c000000000000000000000000001200000`    |
| USDC        | 1337     | `00000539` | `0x0000053900000000000000000000000001200000`    |

**Foreign assets** (prefix `0x0220`):

```
ERC20 address = 0x<index hex, 8 chars>00000000000000000000000002200000
```

Foreign asset indices are assigned sequentially by `pallet-assets-precompiles` when the asset is registered via the `ForeignAssets` pallet. Query the index on-chain via `ForeignAssetIdToAssetIndex` storage.

See [how it works](how-it-works.md#supported-asset-types) for details on asset types and XCM location configuration.

### Creating a Market

Markets are created via `createMarket()`, which takes a `TokenConfig` struct for each token:

```solidity
struct TokenConfig {
    address token;       // ERC20 precompile address
    bytes xcmLocation;   // SCALE-encoded XCM Location (empty for trust-backed assets)
}
```

For trust-backed assets, leave `xcmLocation` empty. For foreign assets, provide the SCALE-encoded XCM Location (see [Configuring XCM Locations](how-it-works.md#configuring-xcm-locations)).

```bash
cast send <FACTORY_ADDRESS> \
    "createMarket((address,bytes),(address,bytes),uint96,uint96,uint128)" \
    "(<BASE_ERC20>,0x)" "(<QUOTE_ERC20>,0x)" \
    <TICK_SIZE> <MIN_ORDER_SIZE> <MAX_ORDER_SIZE> \
    --chain polkadot-testnet \
    --private-key $DEPLOYER_PRIVATE_KEY
```

Example: XAUT/USDT market (both trust-backed `pallet-assets` tokens, 6 decimals), tick size $0.01, min 0.001 XAUT, max 1000 XAUT:

```bash
cast send 0x... \
    "createMarket((address,bytes),(address,bytes),uint96,uint96,uint128)" \
    "(0x...XAUT,0x)" "(0x000007c000000000000000000000000001200000,0x)" \
    10000000000000000 1000 1000000000 \
    --chain polkadot-testnet \
    --private-key $DEPLOYER_PRIVATE_KEY
```

Where `10000000000000000` = 0.01 × 10¹⁸ (tick), `1000` = 0.001 × 10⁶ (min), `1000000000` = 1000 × 10⁶ (max). The `0x` in each tuple is an empty `xcmLocation` (trust-backed asset).

See [configuration](configuration.md) for how to calculate these values for different token decimal combinations.

### Market Key Normalization

The factory normalizes market keys by sorting token addresses: `createMarket(A, B)` and `createMarket(B, A)` both map to the same key. Attempting to create a duplicate market reverts with `MarketExists`. You can look up any market with `getMarket(base, quote)` using either token order.

### Validation Rules

`createMarket()` reverts if:

- `baseToken == quoteToken` → `SameToken`
- Either token is `address(0)` → `ZeroAddress`
- `tickSize == 0` → `ZeroTickSize`
- `minOrderSize == 0` → `ZeroMinOrderSize`
- `maxOrderSize < minOrderSize` → `MaxBelowMin`
- Market already exists → `MarketExists`
- `msg.value < marketCreationDeposit` → `InsufficientDeposit`

## Interacting with the Contract

Read the admin address:

```bash
cast call <FACTORY_ADDRESS> "admin()(address)" --chain polkadot-testnet
```

Check your account balance:

```bash
cast balance $ACCOUNT_ADDRESS --chain polkadot-testnet
```

Query a market address:

```bash
cast call <FACTORY_ADDRESS> \
    "getMarket(address,address)(address)" \
    <BASE_ERC20> <QUOTE_ERC20> \
    --chain polkadot-testnet
```

Read order book depth (top 5 price levels on the bid side):

```bash
cast call <MARKET_ADDRESS> \
    "getOrderBook(uint8,uint8)(uint96[],uint128[],uint8)" \
    0 5 \
    --chain polkadot-testnet
```

Where the first argument is the side (`0` = Buy, `1` = Sell) and the second is the number of price levels.

## Verify on Blockscout

Verify on Blockscout (no API key needed):

```bash
forge verify-contract <DLOB_IMPL_ADDRESS> src/DLOB.sol:DLOB \
    --chain polkadot-testnet

forge verify-contract <FACTORY_ADDRESS> src/DLOBFactory.sol:DLOBFactory \
    --chain polkadot-testnet
```

Blockscout URLs:

| Network                   | Explorer                                              |
| ------------------------- | ----------------------------------------------------- |
| Paseo Asset Hub (testnet) | `https://blockscout-testnet.polkadot.io`              |
| Polkadot Asset Hub        | `https://blockscout.polkadot.io`                      |

## Admin Operations

The deployer is the initial factory admin. Admin capabilities:

| Function                    | Description                                                      |
| --------------------------- | ---------------------------------------------------------------- |
| `setMinCrossChainFee()`     | Set the minimum DOT fee reserve for cross-chain orders           |
| `setMarketCreationDeposit()`| Set the DOT deposit required to create a market                  |
| `transferAdmin()`           | Transfer admin role to a new address (irreversible)              |
| `adminRedirectClaim()`      | Redirect any pending claim to a different destination (emergency) |
| `sweepOrphanedDot()`        | Withdraw orphaned DOT from a market contract (emergency)         |

> **Note:** `transferAdmin()` is irreversible. There is no two-step transfer or timelock. Double-check the new admin address before calling.
