# SubsTrade Hub

A fully on-chain **Decentralized Limit Order Book** for [Polkadot Asset Hub](https://docs.polkadot.com/smart-contracts/), built with Solidity on [pallet-revive](https://docs.polkadot.com/polkadot-protocol/smart-contract-basics/). Natively multi-chain, traders on any Polkadot parachain can place and settle orders via [XCM](https://docs.polkadot.com/parachains/interoperability/get-started/) in a single extrinsic, without bridging tokens manually or managing accounts on Asset Hub.

## What is a DLOB?

A **Decentralized Limit Order Book (DLOB)** is a trading mechanism where buyers and sellers submit orders at specific prices, and a matching engine pairs them together, all running on-chain with no centralized intermediary.

Unlike AMMs (Automated Market Makers) that use liquidity pools and bonding curves, a DLOB works like a traditional exchange order book:

- **Buyers** post bids: "I want to buy 100 tokens at $1.50 each"
- **Sellers** post asks: "I want to sell 200 tokens at $1.55 each"
- When a bid price meets or exceeds an ask price, the **matching engine** fills the trade
- Unfilled orders **rest on the book** until matched, cancelled, or expired

This gives traders precise control over execution price, supports true price discovery, and avoids the slippage and impermanent loss inherent in AMM designs.

Example: [XAUT](https://gold.tether.to/) (Tether Gold, a tokenized gold asset) traded against USDT.

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
- Market buy for 12 XAUT → sweeps the best asks (10 at $5,148.50, then 2 at $5,148.75)

See [how it works](contracts/docs/how-it-works.md) for the full cross-chain flow, order lifecycle, and feature details.

## Repository Structure

```
substrade-hub/
├── apps/                  # Frontend applications
│   └── trade/             # Trading UI (React + Vite)
├── contracts/             # Foundry project (Solidity smart contracts)
│   ├── src/               # DLOB, DLOBFactory, libraries
│   ├── test/              # Forge unit, fuzz, and invariant tests
│   ├── script/            # Deployment scripts (Solidity)
│   ├── scripts/           # Operational scripts (JS)
│   ├── lib/               # Dependencies (forge-std, OpenZeppelin)
│   ├── docs/              # Contract documentation
│   └── foundry.toml       # Foundry configuration
├── e2e/                   # Rust E2E tests (xcm-emulator)
├── package.json           # Workspace root
├── pnpm-workspace.yaml    # pnpm workspace config
└── turbo.json             # Turborepo task runner
```

## Prerequisites

Install [Foundry for Polkadot](https://github.com/paritytech/foundry-polkadot):

```bash
curl -L https://raw.githubusercontent.com/paritytech/foundry-polkadot/refs/heads/master/foundryup/install | bash
foundryup
```

This fork of Foundry adds support for testing against [pallet-revive](https://github.com/paritytech/polkadot-sdk/tree/master/substrate/frame/revive) (the actual Polkadot smart contract execution layer) via the `--polkadot` flag.

Get testnet PAS tokens from the [Paseo faucet](https://faucet.polkadot.io/) to pay for gas on Paseo Asset Hub.

## Build

```bash
cd contracts && forge build
```

The project compiles with Solc 0.8.28, EVM target `prague`, and `via_ir = true` (required due to contract size). See `contracts/foundry.toml` for full config.

## Test

```bash
cd contracts && forge test
```

End-to-end tests run the full Westend relay + Asset Hub + PenpalA network in-process via `xcm-emulator`, covering contract deployment, local settlement, and cross-chain order flow:

```bash
cd e2e && cargo test -- --nocapture
```

See the [testing guide](contracts/docs/testing.md) for gas reporting, invariant tests, and the full Solidity test suite breakdown. See the [e2e README](e2e/README.md) for the emulated XCM test scenarios.

## Deploy

Deploy the factory and create markets on Paseo Asset Hub (testnet) or Polkadot Asset Hub (mainnet) using `forge script` and `cast send`.

See the [deployment guide](contracts/docs/deployment.md) for full instructions and [configuration](contracts/docs/configuration.md) for market parameters and factory setup.

## Architecture

```
RedBlackTree (deployed library, ~6KB)
  └── delegatecall from DLOB for O(log n) tree operations

XcmBuilder (deployed library, ~3KB)
  └── delegatecall from DLOB to build SCALE-encoded XCM messages

DLOBFactory (~2KB)
  └── creates EIP-1167 minimal proxy clones of DLOB implementation
        └── DLOB clone (~45 bytes proxy → delegates to implementation)
              ├── RedBlackTree library (bid + ask price levels, O(log n))
              ├── XcmBuilder library (XCM message encoding)
              ├── FIFO Order Queue (per price level, doubly-linked list)
              ├── Matching Engine (up to 50 fills per tx)
              └── XCM Settlement (inline or pending claim fallback)
```

Each market is a **DLOB** contract that maintains two red-black trees (one for bids, one for asks), giving O(log n) price level insertion and O(1) best bid/ask lookup. Within each price level, orders sit in a FIFO queue (doubly-linked list) so the matching engine can fill them in time priority. When a new order crosses the spread, the engine walks the opposite tree and fills up to 50 orders per transaction. For cross-chain traders, filled tokens are delivered via XCM reserve transfers; if delivery fails, a `PendingClaim` stores the settlement for later retry.

**DLOBFactory** creates new markets as EIP-1167 minimal proxy clones of a single DLOB implementation. The architecture uses two patterns to stay within the EIP-170 contract size limit (24KB) enforced by pallet-revive:

- **External libraries.** RedBlackTree (~6KB) and XcmBuilder (~3KB) are deployed separately and called via `delegatecall`, keeping their bytecode out of DLOB's runtime code.
- **EIP-1167 clones.** Each market is a minimal proxy (~45 bytes) that delegates to a single DLOB implementation, so DLOBFactory doesn't embed DLOB's creation bytecode.

## Networks


| Network                   | RPC                                             | Chain ID  |
| ------------------------- | ----------------------------------------------- | --------- |
| Paseo Asset Hub (testnet) | `https://services.polkadothub-rpc.com/testnet/` | 420420417 |
| Polkadot Asset Hub        | `https://services.polkadothub-rpc.com/mainnet`  | 420420419 |
| Kusama Asset Hub          | `https://kusama-asset-hub-eth-rpc.polkadot.io`  | 420420418 |


## Documentation

- [How it works](contracts/docs/how-it-works.md): Order lifecycle, cross-chain flow, XCM settlement
- [Deployment guide](contracts/docs/deployment.md): Deploy factory, create markets, verify on Blockscout
- [Configuration](contracts/docs/configuration.md): Market parameters, factory parameters, trading with DOT
- [Testing](contracts/docs/testing.md): Test suite, invariant tests, gas reporting
- [Polkadot Smart Contracts](https://docs.polkadot.com/smart-contracts/)
- [Foundry for Polkadot](https://github.com/paritytech/foundry-polkadot)
- [XCM Documentation](https://docs.polkadot.com/parachains/interoperability/get-started/)
- [pallet-revive](https://docs.polkadot.com/polkadot-protocol/smart-contract-basics/)

## License

GPL-3.0-only. See [LICENSE](LICENSE) for details.
