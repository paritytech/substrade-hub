# SubsTrade Hub — Contracts

Solidity smart contracts for the SubsTrade decentralized limit order book, built with [Foundry for Polkadot](https://github.com/paritytech/foundry-polkadot) targeting [pallet-revive](https://docs.polkadot.com/polkadot-protocol/smart-contract-basics/) on Asset Hub.

## Build

```bash
forge build
```

Compiles with Solc 0.8.28, EVM target `prague`, and `via_ir = true` (required due to contract size). See `foundry.toml` for full config.

## Test

```bash
forge test
```

See the [testing guide](docs/testing.md) for gas reporting, invariant tests, and the full test suite breakdown.

## Deploy

Deploy the factory and create markets on Paseo Asset Hub (testnet) or Polkadot Asset Hub (mainnet) using `forge script` and `cast send`.

See the [deployment guide](docs/deployment.md) for full instructions and [configuration](docs/configuration.md) for market parameters.

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

- [How it works](docs/how-it-works.md): Order lifecycle, cross-chain flow, XCM settlement
- [Deployment guide](docs/deployment.md): Deploy factory, create markets, verify on Blockscout
- [Configuration](docs/configuration.md): Market parameters, factory parameters, trading with DOT
- [Testing](docs/testing.md): Test suite, invariant tests, gas reporting
- [Admin powers](docs/admin.md): What the factory admin can do, and custody before mainnet
