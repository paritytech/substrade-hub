[← Back to README](../README.md)

# Configuration

## Market Parameters

Each market is created with three parameters that control price precision and order sizing.
All values are integers, no floating-point. Prices are **quote raw units per base raw unit, in 18-decimal fixed-point** (see [Price Calculation](#price-calculation)); amounts use the **base token's native decimals**.


| Parameter      | Type      | Unit                   | Description                                                                |
| -------------- | --------- | ---------------------- | -------------------------------------------------------------------------- |
| `tickSize`     | `uint96`  | Price (raw)            | Minimum price increment. All limit prices must be multiples of this value. |
| `minOrderSize` | `uint96`  | Base token raw units   | Smallest allowed order amount. Orders below this are rejected.             |
| `maxOrderSize` | `uint128` | Base token raw units   | Largest allowed order amount. Orders above this are rejected.              |


### How Tick Size Works

All limit order prices must be exact multiples of `tickSize`. The contract checks this with `price % tickSize == 0` and reverts with `NotTickAligned` if it fails. A smaller tick size allows finer price granularity but increases the number of possible price levels.

For example, for two tokens with the same decimals and `tickSize = 10000000000000000` (0.01):
- `5148250000000000000000` ($5,148.25): valid (multiple of tick)
- `5148255000000000000000` ($5,148.255): reverts with `NotTickAligned`

### Price Calculation

A raw price is the quote raw units paid for one base raw unit, scaled by 10¹⁸. The formula to convert a human-readable price (quote tokens per base token) to the raw value:

```
rawPrice = humanPrice × 10^(18 + quoteDecimals − baseDecimals)
```

When both tokens have the same decimals, this is `humanPrice × 10¹⁸`.

Quote amounts (how much quote token to escrow for a buy order) are calculated as:

```
quoteAmount = (baseAmount × price) / 10¹⁸     (floor division for fills)
quoteAmount = ⌈(baseAmount × price) / 10¹⁸⌉   (ceiling division for escrow)
```

The contract uses ceiling division when escrowing quote tokens for buy orders to ensure the escrow always covers the fill. Any excess is refunded after matching.

### Examples

**XAUT/USDT market** (both tokens have 6 decimals):


| Parameter      | Human value | Raw value           | Calculation  |
| -------------- | ----------- | ------------------- | ------------ |
| `tickSize`     | $0.01       | `10000000000000000` | 0.01 × 10¹⁸ |
| `minOrderSize` | 0.001 XAUT  | `1000`              | 0.001 × 10⁶ |
| `maxOrderSize` | 1,000 XAUT  | `1000000000`        | 1000 × 10⁶  |


**ETH/USDC market** (ETH with 18 decimals, USDC with 6 decimals):


| Parameter      | Human value | Raw value              | Calculation   |
| -------------- | ----------- | ---------------------- | ------------- |
| `tickSize`     | $0.10       | `100000`               | 0.10 × 10⁶ (10¹⁸⁺⁶⁻¹⁸) |
| `minOrderSize` | 0.01 ETH    | `10000000000000000`    | 0.01 × 10¹⁸  |
| `maxOrderSize` | 100 ETH     | `100000000000000000000`| 100 × 10¹⁸   |

Note that `minOrderSize` and `maxOrderSize` always use the **base token's native decimals**, while `tickSize` is a price and follows the price formula above.

> **Why the 10¹⁸ scale?** It keeps prices exact when one base raw unit is worth a fraction of a quote raw unit, as with tokens of equal decimals. Different decimals shift the scale by 10^(quoteDecimals − baseDecimals), and the contract does no other decimal conversion. The trading app lists only markets whose base and quote tokens have the same decimals.

## Factory Parameters

Global parameters configurable by the factory admin after deployment:


| Parameter               | Default | Unit               | Description                                                                                 |
| ----------------------- | ------- | ------------------ | ------------------------------------------------------------------------------------------- |
| `minCrossChainFee`      | 0       | Planck             | DOT each XCM settlement leg takes from the order's fee reserve. 0 disables cross-chain orders; 1 is refused (`FeeTooLow`). |
| `marketCreationDeposit` | 0       | Planck             | Optional deposit required to create a new market. Set to 0 to allow free market creation.   |


DOT on Asset Hub uses **10 decimals** (1 DOT = 10,000,000,000 Planck). Both parameters are in planck, while the `msg.value` that pays them is in 18-decimal units, `NATIVE_TO_ETH_RATIO` (10^8 here) per planck: a 1 DOT deposit is sent as `10000000000 * 10^8`. When setting these parameters, convert accordingly:

| Human value | Planck value       |
| ----------- | ------------------ |
| 0.01 DOT    | `100000000`        |
| 0.1 DOT     | `1000000000`       |
| 1 DOT       | `10000000000`      |

### Setting Factory Parameters

```bash
# Set minimum cross-chain fee to 0.01 DOT
cast send <FACTORY_ADDRESS> \
    "setMinCrossChainFee(uint128)" \
    100000000 \
    --chain polkadot-testnet \
    --private-key $DEPLOYER_PRIVATE_KEY

# Set market creation deposit to 1 DOT
cast send <FACTORY_ADDRESS> \
    "setMarketCreationDeposit(uint128)" \
    10000000000 \
    --chain polkadot-testnet \
    --private-key $DEPLOYER_PRIVATE_KEY
```

### Reading Current Configuration

```bash
# Check current min cross-chain fee
cast call <FACTORY_ADDRESS> "minCrossChainFee()(uint128)" --chain polkadot-testnet

# Check market creation deposit
cast call <FACTORY_ADDRESS> "marketCreationDeposit()(uint128)" --chain polkadot-testnet

# Check admin address
cast call <FACTORY_ADDRESS> "admin()(address)" --chain polkadot-testnet

# Check total markets created
cast call <FACTORY_ADDRESS> "getMarketCount()(uint256)" --chain polkadot-testnet
```

## Trading with DOT

The DLOB requires all traded tokens to be ERC20s backed by `pallet-assets`. DOT is the native token on Asset Hub and is not registered in `pallet-assets`, so it cannot be used directly as a base or quote token.

To trade DOT, it would need to exist as a `pallet-assets` asset, for example a wrapped DOT registered on Asset Hub with its own ERC20 precompile, which may require a governance proposal. A WDOT deployed as a plain contract, as Ethereum's WETH is, could back a market for local orders only, since XCM cannot move it.

Once WDOT is available, it can be used as the base or quote token in any market. For example, a **WDOT/USDT** market would let traders place DOT-denominated orders with USDT settlement.

> **Note:** The DOT fee reserve (native DOT sent as `msg.value` for cross-chain settlement) is separate from WDOT. The fee reserve is required for all cross-chain orders regardless of which tokens are being traded. WDOT is only needed to trade DOT itself as a market asset.
