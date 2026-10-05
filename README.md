> [!WARNING]
> This open source code is provided for research, experimentation, and developer education only. This code has not been audited, is actively experimental, and may contain bugs, vulnerabilities, or incomplete features. Use at your own risk and obtain legal advice as appropriate - DYOR.
>
> Parity doesn’t deploy the code but may update it based on community feedback.
>
> If you experience problems with any product or service that was built on or deployed from this code, you should contact the third party who deployed the code in its amended form, not Parity.


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

## Quick Start

The app targets one network at a time, picked by `VITE_NETWORK` from
[`apps/trade/src/config/networks.json`](apps/trade/src/config/networks.json). That file holds each
network's genesis, endpoints, dotNS name and contract addresses.

```bash
pnpm install

# Start the trading UI against previewnet
cd apps/trade
VITE_NETWORK=previewnet pnpm dev
```

### Bootstrapping a network

`contracts/scripts/bootstrap.mjs` rebuilds the demo on a network from scratch. It funds generated EVM
keys, creates the tUSD, tNVDA and tMU assets, deploys the DLOB factory and the tUSD faucet, creates the
tNVDA/tUSD and tMU/tUSD markets, seeds their order books, generates a trade history for the candle
chart, and writes the new addresses into `networks.json`. Run it again after a chain reset.

```bash
cd contracts
node scripts/bootstrap.mjs --network previewnet          # every step (about 20 minutes)
node scripts/bootstrap.mjs --network previewnet --only fund --fund <ss58>   # top up one more account
```

The funder (`FUNDER_URI`, default `//Alice`) pays native funds and administers the test assets, so it
must hold PAS on that network. Steps are idempotent and record their progress in
`contracts/scripts/state/<network>.json`, which holds the generated keys and is gitignored; an
interrupted run resumes where it stopped. Run `node scripts/bootstrap.mjs --help` for every option.

To trade from the UI, connect an **EVM wallet** (MetaMask) or a **Substrate wallet** (SubWallet or
polkadot-js), and claim test tUSD from the faucet on the home page. Supported wallets, the one-time
network-metadata approval, and troubleshooting are documented in
[`apps/trade/docs/wallets.md`](apps/trade/docs/wallets.md).

## Contracts

Build, test, deploy, and architecture details: see [`contracts/README.md`](contracts/README.md).

## End-to-End Tests

Full Westend relay + Asset Hub + PenpalA network tests via `xcm-emulator`:

```bash
cd e2e && cargo test -- --nocapture
```

See the [e2e README](e2e/README.md) for test scenarios.

## Security

Before deploying it for real use cases, you are responsible for:

- Reviewing the code yourself, we publish a reference, not a hardened production build
- Checking that the dependencies are up to date and free of known vulnerabilities
- Securing your own fork or deployment environment (keys, secrets, network configuration)
- Tracking the latest tagged release/commits for security fixes; older releases are not backported (exceptions might apply)

For Parity's security disclosure process, and Bug Bounty program, feel free to visit:  https://parity.io/bug-bounty

## License

Licensed under the MIT License. See [LICENSE](./LICENSE) and [NOTICE](./NOTICE). The polkadot-sdk precompile interfaces under `contracts/src/interfaces/` retain their upstream licence (the SPDX header in each file is authoritative).
