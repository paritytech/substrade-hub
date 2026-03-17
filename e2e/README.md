# E2E Tests

End-to-end tests for the DLOB (Decentralized Limit Order Book) contracts on Asset Hub (AH) Westend.

Uses polkadot-sdk's `xcm-emulator` to run the full Westend relay + Asset Hub +
PenpalA network in-process. Local contract calls use `pallet_revive` directly
(`bare_instantiate` / `bare_call`); cross-chain orders use real XCM Transact
from PenpalA over HRMP.

## Quick start

```bash
# 1. Build the Solidity contracts (from repo root)
forge build

# 2. Run tests
cd e2e
cargo test -- --nocapture
```

## What the tests cover

### Pallet asset tests (`pallet_asset_tests.rs`)

`full_dlob_lifecycle` runs scenarios **t0 → t4** sequentially in one test
(each scenario's on-chain state feeds into the next).
These use **trust-backed pallet assets** (prefix `0x0120`).

| Scenario                        | Description                                                                                                                         |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| **t0 — Setup check**            | Verify assets exist, accounts are funded, contracts deployed correctly                                                              |
| **t1 — Local settlement**       | Bob places a BUY from AH, Dave places a SELL from AH at the same price → engine matches them → ERC-20 tokens swap on AH             |
| **t2 — Cross-chain order**      | PenpalA sends XCM Transact over HRMP (approve + placeLimitOrder) → order rests on the book                                         |
| **t3 — Cross-chain settlement** | Another XCM Transact BUY + Dave's local SELL → match → base tokens delivered to Charlie on PenpalA via XCM reserve transfer        |
| **t4 — Cross-chain cancel**     | XCM Transact places then cancels a resting order → refund `PendingClaim` created                                                   |

Two additional **standalone smoke tests** run independently:

- `hrmp_message_from_penpal_to_asset_hub_works` — basic XCM message delivery between parachains
- `xcm_transact_revive_call_on_asset_hub` — XCM Transact invoking `pallet_revive::call` on Asset Hub

### Foreign asset tests (`foreign_asset_tests.rs`)

These test markets where the base token is a **foreign asset** (prefix `0x0220`),
registered via the `ForeignAssets` pallet with an explicit SCALE-encoded XCM
Location stored in `TokenConfig.xcmLocation` at market creation time.

| Scenario                              | Description                                                                                              |
| ------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| **foreign_asset_local_settlement**    | Register a bridged Ethereum asset (tWETH) on AH, create a tWETH/tUSD market with xcmLocation, verify local BUY+SELL settlement |

## Actors


| Account            | Role                                                                                       |
| ------------------ | ------------------------------------------------------------------------------------------ |
| **Alice**          | Asset admin, contract deployer                                                             |
| **Bob**            | Local buyer on Asset Hub                                                                   |
| **Dave**           | Local seller on Asset Hub                                                                  |
| **Charlie**        | Cross-chain trader on PenpalA (para 2000)                                                  |
| **Sovereign 2000** | PenpalA's sovereign account on Asset Hub, executes cross-chain orders on behalf of Charlie |


## File structure

```
e2e/src/
  lib.rs                           # Crate root, declares test module
  tests/
    mod.rs                         # Shared imports, constants, helpers, setup
    pallet_asset_tests.rs          # Trust-backed asset lifecycle + smoke tests
    foreign_asset_tests.rs         # Foreign asset (0x0220) market tests
```

## Network topology

The tests use polkadot-sdk's `xcm-emulator`, which runs real relay and parachain
runtimes in a single process. Each chain executes in its own `TestExternalities`
and XCM messages are relayed between them automatically at the end of every
`execute_with` block. This gives us production-equivalent XCM routing, barriers,
and fee logic.

```
┌─────────────┐
│ Relay Chain │  Westend
└──────┬──────┘
       │
  ┌────┴────┐
  │         │
  ▼         ▼
┌──────┐  ┌──────────┐
│  AH  │  │ PenpalA  │   PenpalA is a generic test parachain
│ 1000 │  │   2000   │   provided by polkadot-sdk
└──────┘  └──────────┘
    HRMP channels pre-configured in both directions
```


