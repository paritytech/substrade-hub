[← Back to README](../README.md)

# Testing

## Running Tests

Run tests against pallet-revive (the actual Polkadot smart contract runtime):

```bash
forge test --polkadot
```

This uses the pallet-revive EVM backend, so tests execute in the same runtime as production. You can also run against standard Anvil (without `--polkadot`) for faster iteration during development.

### Verbosity Levels

Foundry supports verbosity flags for debugging:

| Flag  | Output                                            |
| ----- | ------------------------------------------------- |
| `-v`  | Show test names and pass/fail status              |
| `-vv` | Also show `console.log` and `emit` output         |
| `-vvv`| Also show stack traces for failing tests          |
| `-vvvv`| Also show setup traces and all contract calls    |

### Common Commands

Run with gas reporting:

```bash
forge test --gas-report
```

Run a specific test file:

```bash
forge test --polkadot --match-path test/Matching.t.sol -vv
```

Run a specific test function:

```bash
forge test --polkadot --match-test "testMultiLevelFill" -vv
```

Run invariant tests only (takes ~30 min):

```bash
forge test --match-test "invariant_" -vv
```

Run fuzz tests only:

```bash
forge test --match-test "testFuzz" -vv
```

## Test Suite


| File                | Tests | Coverage                                                                 |
| ------------------- | ----- | ------------------------------------------------------------------------ |
| `DLOB.t.sol`        | 53    | Order placement, post-only, cancellation, reduction, matching, self-trade, expiry, depth integrity, views, admin |
| `DLOBFactory.t.sol` | 29    | Market creation, duplicate prevention, parameter validation, admin config |
| `Matching.t.sol`    | 22    | Multi-level fills, market orders and their limit price, max fills cap, self-trade, slippage, buyer refunds, pull validation |
| `CrossChain.t.sol`  | 33    | Inline XCM, claim fallback, fee reserve lifecycle, claim redirect, XCM failure recovery (see [how it works](how-it-works.md)) |
| `GasReport.t.sol`   | 12    | Gas benchmarks for all core operations                                   |
| `DLOB.fuzz.t.sol`   | 15    | 7 fuzz tests (257 runs) + 8 stateful invariants (128k calls each)        |
| `NativeValue.t.sol` | 14    | `msg.value` against planck at a 10^8 ratio: the ratio check, fee and deposit caps, the fee reserve, settlement, fill and refund claims, sweeps |
| `Faucet.t.sol`      | 8     | tUSD faucet: drip, per-address cooldown, owner-only withdraw and drip changes |

### Test Infrastructure

All tests follow the same setup pattern:

1. Deploy `DLOBFactory` with mock XCM and System precompiles
2. Create a market via `factory.createMarket()` with `TokenConfig` structs (empty `xcmLocation` for mock tokens)
3. Mint test tokens (MockERC20) to test accounts
4. Approve the DLOB market to spend tokens

Test accounts are fixed addresses (`alice = address(0xA11CE)`, and so on):

| Account   | Role                                    |
| --------- | --------------------------------------- |
| `alice`   | Primary buyer                           |
| `bob`     | Primary seller                          |
| `charlie` | Secondary trader for multi-user tests   |

Standard test constants:

| Constant        | Value  | Description                           |
| --------------- | ------ | ------------------------------------- |
| `TICK_SIZE`     | `1e15` | 0.001 in 18-decimal fixed-point       |
| `MIN_ORDER_SIZE`| `1e6`  | 1.0 in 6-decimal token units          |
| `MAX_ORDER_SIZE`| `1e24` | Very large max for test flexibility    |
| `PRECISION`     | `1e18` | Price precision constant               |

### Mock Contracts

Tests use mock contracts instead of real precompiles:

- **MockERC20.** Standard ERC20 with public `mint()` and `burn()` functions.
- **MockXcm.** Tracks all `execute()` and `send()` calls in arrays for assertion. Supports `setShouldRevert(true)` to simulate XCM failures and test the PendingClaim fallback path.
- **MockSystem.** Stub implementation of the System precompile.

## Fuzz Testing

Fuzz tests use Foundry's built-in fuzzer with bounded inputs. The fuzzer generates random values for function parameters, and `vm.bound()` constrains them to valid ranges.

Configuration (from `foundry.toml`):

| Setting                | Default | CI Profile |
| ---------------------- | ------- | ---------- |
| `fuzz.runs`            | 256     | 256        |
| `invariant.runs`       | 256     | 16         |
| `invariant.depth`      | 500     | 256        |

Fuzz tests cover:

- **Price alignment.** Random prices validated against tick alignment.
- **Amount boundaries.** Random amounts checked against min/max.
- **Cancel-and-reduce.** Random sequences of place/cancel/reduce.
- **Matching with expiry.** Time-warped orders expiring during fills.
- **Multi-order same price.** FIFO ordering within a price level.

## Invariant Testing

Invariant tests use a **handler pattern**: a `DLOBHandler` contract that wraps DLOB calls with bounded random inputs. The fuzzer calls handler functions in random sequences, and after each call sequence, invariant assertions are checked.

The handler tracks **ghost variables** (off-chain accounting) to compare against on-chain state:

| Ghost variable                  | Tracks                                        |
| ------------------------------- | --------------------------------------------- |
| `ghostTotalActiveBuyEscrow`     | Sum of quote tokens escrowed by active buys   |
| `ghostTotalActiveSellEscrow`    | Sum of base tokens escrowed by active sells   |
| `ghostTotalOrders`              | Total orders placed                           |

### Invariants Verified

| Invariant                              | What it checks                                       |
| -------------------------------------- | ---------------------------------------------------- |
| `invariant_BestBidLessThanBestAsk`     | Spread never inverts (no crossed book)               |
| `invariant_BaseTokenConservation`      | Contract holds enough base tokens for all active sells |
| `invariant_QuoteTokenConservation`     | Contract holds enough quote tokens for all active buys |
| `invariant_OrderIdsSequential`         | Order IDs are allocated sequentially                 |
| `invariant_FeeReserveBalance`          | Contract DOT balance >= tracked fee reserve total    |
| `invariant_ActiveOrdersHaveAmount`     | Active orders always have `remainingAmount > 0`      |
| `invariant_PricesTickAligned`          | All order prices are multiples of tick size          |
| `invariant_OrderAmountBounds`          | Original amounts are within min/max bounds           |

## Gas Benchmarks

`GasReport.t.sol` provides isolated gas measurements for core operations. They are REVM gas, which says
nothing about proof size or pallet-revive's weights: what each operation costs on Asset Hub, against
what one transaction may use, is in [Benchmarks](benchmarks.md). Run with:

```bash
forge test --match-path test/GasReport.t.sol --gas-report
```

Benchmarked operations:

| Operation                    | Description                                              |
| ---------------------------- | -------------------------------------------------------- |
| First order placement        | Cold storage; creates first price level                  |
| New price level              | Insert into red-black tree                               |
| Existing price level         | Append to FIFO queue (no tree insertion)                 |
| Local match                  | Direct ERC20 transfer settlement                         |
| Cross-chain match (inline)   | XCM settlement succeeds inline                           |
| Cross-chain match (fallback) | XCM fails → PendingClaim created                         |
| Claim settlement             | Execute pending XCM delivery                             |
| Cancel (local)               | Cancel + refund escrowed tokens                          |
| Cancel (cross-chain)         | Cancel + create refund PendingClaim                      |
| Reduce order                 | Shrink amount + partial refund                           |
| Match with expired orders    | Lazy cleanup cost during matching                        |
| 10-order match               | Measure fill loop cost at scale                          |
