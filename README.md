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
│   └── docs/              # Contract documentation
├── e2e/                   # Rust E2E tests (xcm-emulator)
├── package.json           # Workspace root
├── pnpm-workspace.yaml    # pnpm workspace config
└── turbo.json             # Turborepo task runner
```

## Prerequisites

- [Node.js](https://nodejs.org/) v20+ and [pnpm](https://pnpm.io/installation) (for scripts and trading UI)
- [Foundry for Polkadot](https://github.com/paritytech/foundry-polkadot) (for contracts)

Install Foundry:

```bash
curl -L https://raw.githubusercontent.com/paritytech/foundry-polkadot/refs/heads/master/foundryup/install | bash
foundryup
```

Get testnet PAS tokens from the [Paseo faucet](https://faucet.polkadot.io/) to pay for gas on Paseo Asset Hub.

## Quick Start

```bash
pnpm install

# Set up environment
cd contracts
cp scripts/.env.example scripts/.env
# Edit scripts/.env: set ALICE_SEED, DEPLOYER_PRIVATE_KEY, and DLOB_FACTORY_ADDRESS
# Fund Alice via https://faucet.polkadot.io/?parachain=paseo-asset-hub

# Bootstrap a test market with order book and trade history
node scripts/bootstrap-nvda.mjs --from 1 --to 5

# Start the trading UI
cd ../apps/trade
pnpm dev
```

The bootstrap script creates tUSD + tNVDA assets, a market at ~$175, seeds the order book ($170–$180), generates trades with a realistic candle pattern, and replenishes the book.

To trade from the UI you can connect either an **EVM wallet** (import the Deployer EVM private key into MetaMask) or a **Substrate wallet** (SubWallet or polkadot-js). Supported wallets, the one-time network-metadata approval, and troubleshooting (stale sessions, reverts, market-order races) are documented in [`apps/trade/docs/wallets.md`](apps/trade/docs/wallets.md).

To regenerate trade history on an existing market (sweeps stale orders, re-seeds, re-trades):

```bash
cd contracts && node scripts/bootstrap-nvda.mjs --from 3 --to 5
```

## Contracts

Build, test, deploy, and architecture details: see [`contracts/README.md`](contracts/README.md).

## End-to-End Tests

Full Westend relay + Asset Hub + PenpalA network tests via `xcm-emulator`:

```bash
cd e2e && cargo test -- --nocapture
```

See the [e2e README](e2e/README.md) for test scenarios.

## License

GPL-3.0-only. See [LICENSE](LICENSE) for details.
