# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

SubsTrade Hub is a fully on-chain **Decentralized Limit Order Book (DLOB)** for Polkadot Asset Hub, written in Solidity and deployed to **pallet-revive** — Polkadot's smart-contract runtime, not a standard EVM chain. It is natively multi-chain: a trader on any parachain places and settles an order on Asset Hub via XCM in a single extrinsic, without bridging tokens or managing an Asset Hub account.

## Repository layout

| Path | Stack | Role |
|------|-------|------|
| `contracts/` | Foundry (Solidity) | The DLOB matching engine — the core of the project |
| `apps/trade/` | React + Vite + TypeScript | Trading UI; talks to Asset Hub via `polkadot-api` (papi) + `viem` |
| `e2e/` | Rust | Integration tests using polkadot-sdk's `xcm-emulator` (in-process Westend relay + Asset Hub + PenpalA; no external node) |

The JS side is a pnpm + Turborepo workspace pinned to `pnpm@11.20.0` (`packageManager` field). Node 26 dropped bundled corepack, so if `pnpm` is missing, install it with `npm install -g pnpm@11.20.0` rather than relying on corepack.

The docs are thorough and worth reading before deep work: `contracts/docs/{how-it-works,deployment,configuration,testing}.md` and `e2e/README.md`.

## Commands

### Contracts (run inside `contracts/`)

```bash
forge build                                       # Solc 0.8.28, evm=prague, via_ir=true
forge test                                        # runs on plain Anvil — fast, tests use mock precompiles
forge test --polkadot                             # runs against pallet-revive (production semantics) — what CI runs
forge test --polkadot --match-path test/Matching.t.sol -vv   # single file
forge test --polkadot --match-test testPartialFill           # single test
forge test --gas-report                           # gas benchmarks (test/GasReport.t.sol)
forge fmt                                          # format
```

`forge test` works without `--polkadot` because contract tests use mock precompiles (`MockXcm`/`MockSystem`/`MockERC20`) and don't need the real runtime. Use plain `forge test` for fast iteration, and `--polkadot` for anything that must trust pallet-revive behavior.

CI splits the suite into two jobs:

```bash
forge test --polkadot --no-match-test "invariant_"                  # unit + fuzz (the "Unit & Fuzz" job)
FOUNDRY_PROFILE=ci forge test --polkadot --match-test "invariant_"  # invariants, lightweight profile
```

The invariant suite under the default profile takes ~30 minutes (256 runs × depth 500), which is why CI uses the `ci` profile (16 × 256).

### E2E (two directories — build contracts first, then test)

The e2e crate reads compiled contract artifacts from `contracts/out/`, so the build step runs in `contracts/` and the tests run in `e2e/`:

```bash
# 1. inside contracts/  (CI's e2e job uses working-directory: contracts here too)
forge build

# 2. inside e2e/
cargo test -- --nocapture                        # all current e2e tests
cargo test full_dlob_lifecycle -- --nocapture    # single test
cargo fmt --all --check                          # the only e2e check currently enabled in CI
```

The first `cargo` build compiles the full polkadot-sdk runtime tree and is slow.

### Frontend (run inside `apps/trade/`)

```bash
pnpm dev                # vite dev server
pnpm build              # tsc -b && vite build
pnpm typecheck          # tsc -b
pnpm papi generate      # regenerate .papi descriptors after a polkadot-api bump (uses cached metadata)
```

Frontend validation is `pnpm --filter @substrade-hub/trade` `lint` + `typecheck` + `test` + `build` (eslint flat config in `apps/trade/eslint.config.js`; vitest unit/integration tests as `src/**/*.test.ts`). The `Frontend` CI workflow runs all four.

## Contract architecture

### Working around the 24KB size limit

pallet-revive enforces the EIP-170 24KB contract-size limit, and two patterns exist solely to stay under it. Respect both when editing:

- **External libraries via `delegatecall`.** `RedBlackTree` (~6KB) and `XcmBuilder` (~3KB) are deployed as standalone contracts and called by `delegatecall`, keeping their bytecode out of `DLOB`'s runtime code. `via_ir = true` in `foundry.toml` is also required for size — don't remove it.
- **EIP-1167 minimal-proxy clones.** `DLOBFactory` creates each market as a ~45-byte proxy that delegates to one shared `DLOB` implementation. `forge script DeployFactory` auto-links the libraries (no manual `--libraries` flags).

### Matching engine

Each market is a `DLOB` contract holding two red-black trees — one for bids, one for asks — giving O(log n) price-level insert/remove and O(1) best bid/ask. Within a price level, orders sit in a FIFO doubly-linked list (time priority).

When an order crosses the spread, the engine walks the opposite tree from the best price and fills **up to 50 orders per transaction** (`MAX_FILLS_PER_TX`); any remainder rests at its limit price. Buys execute at the maker's ask, and excess quote is refunded. Expired orders are cleaned up **lazily** when matching encounters them (no keeper). **Self-trade prevention** checks both `msg.sender` and `originAccount` (the trader's Substrate `AccountId32`).

Source: `src/DLOB.sol`, `src/DLOBFactory.sol`, `src/libraries/` (`RedBlackTree`, `XcmBuilder`, `PriceMath`, `ScaleCodec`), `src/interfaces/`, `src/types/TokenConfig.sol`, `src/mocks/`.

### Order model rules (easy to get wrong)

| Rule | Detail |
|------|--------|
| Price units | 18-decimal fixed-point everywhere (`rawPrice = humanPrice × 1e18`), regardless of token decimals. Must be an exact multiple of the market's `tickSize` or it reverts `NotTickAligned`. |
| Amount units | The **base token's native decimals**. |
| DOT units | 10 decimals (1 DOT = 1e10 Planck) — used for fee reserves and factory params. |
| Local vs cross-chain | Decided by `destParaId`. `0` = local (direct ERC20 transfers, no `msg.value`). Non-zero = cross-chain (XCM settlement, requires a DOT fee reserve `msg.value >= factory.minCrossChainFee()`). |
| Allowance | Every order needs a prior `approve(market, amount)` — the DLOB escrows via `transferFrom`. Buys approve quote, sells approve base. |
| Tradeable tokens | **Only pallet-assets-backed precompile tokens**, never user-deployed ERC20s (XCM can only move assets the runtime knows). DOT itself isn't in pallet-assets, so trading DOT needs a WDOT wrapper. |
| Settlement failure | Failed inline XCM creates a **`PendingClaim`** (retry via `claimSettlement`, reroute via `redirectClaim`) instead of reverting — funds are never lost. An order with pending claims can't be cancelled (`HasPendingClaims`). |

### pallet-revive specifics

Precompiles live at fixed addresses:

| Precompile | Address | Interface |
|------------|---------|-----------|
| XCM | `0xA0000` | `IXcm` |
| System | `0x900` | `ISystem` |
| ERC-20 (trust-backed asset) | prefix `0x0120…` | `IERC20` — asset id in upper bytes; XCM Location derivable on-chain (leave `TokenConfig.xcmLocation` empty) |
| ERC-20 (foreign asset) | prefix `0x0220…` | `IERC20` — must supply a SCALE-encoded `xcmLocation`; on-chain code can't derive it |

**Address mapping:** an `H160` maps to an `AccountId32` as `H160 ++ 0xEE*12`; the reverse derivation is `keccak_256(account_id)[12..]`. Asset Hub Westend sets pallet-revive `AutoMap = true`, so accounts auto-map to their H160 on creation and explicit `map_account` calls are unnecessary there. (Note: `how-it-works.md` still documents manual `map_account`, which predates AutoMap.)

### Contract tests

`contracts/test/` holds unit, fuzz, and invariant tests. Invariants use a **handler pattern** — a `DLOBHandler` wraps DLOB calls with bounded random inputs — plus **ghost variables** (off-chain accounting) checked against on-chain state, verifying that the spread never inverts, tokens are conserved, the fee-reserve balance holds, order ids stay sequential, and prices stay tick-aligned. `MockXcm.setShouldRevert(true)` simulates XCM failure to exercise the `PendingClaim` path. Full breakdown in `docs/testing.md`.

## E2E tests

`e2e/Cargo.toml` pins polkadot-sdk dependencies to **`branch = "master"`** — a floating git pin, not a release tag. Running `cargo update` moves the pinned commit and can surface upstream breaking changes (pallet or runtime-API renames); expect to fix those when bumping.

`xcm-emulator` runs the Westend relay + Asset Hub (para 1000) + PenpalA (para 2000) in a single process, with HRMP preconfigured, relaying XCM at the end of each `execute_with` block. Local contract calls go through `pallet_revive` (`bare_instantiate` / `bare_call`); cross-chain orders use a real XCM Transact from PenpalA. `pallet_asset_tests::full_dlob_lifecycle` runs scenarios t0→t4 sequentially with shared state, so order matters.

## Conventions & CI notes

- **CI scope.** Workflows run Foundry build/test/fmt, e2e `cargo fmt`, and a Lychee link check over `*.md` and `contracts/src/**/*.sol` (`.github/workflows/{lint,test,e2e,check-links}.yml`). The full e2e `cargo test` job is commented out — too slow on standard runners.
- **forge fmt drift.** CI installs foundry-polkadot via an **unpinned `foundryup`**, so `forge fmt` is non-deterministic across forge versions — a newer forge can reformat untouched `.sol` files and fail the Lint job. If `forge fmt --check` fails on files you didn't touch, it's version drift; reformat with the current forge rather than assuming your change caused it.
- **Signed commits.** `commit.gpgsign = true` — commits require the configured signing key.
- **Dependabot** is enabled; broad dependency bumps may supersede its open PRs.

### Networks

| Network | Chain ID | Foundry alias | Explorer |
|---------|----------|---------------|----------|
| Paseo Asset Hub (testnet) | 420420417 | `polkadot-testnet` | `blockscout-testnet.polkadot.io` |
| Polkadot Asset Hub (mainnet) | 420420419 | `polkadot` | `blockscout.polkadot.io` |

Aliases are defined in `foundry.toml`; Blockscout verification needs no API key.
