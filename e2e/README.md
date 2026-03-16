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

The tests run **five sequential scenarios** (t0 → t4) inside a single test
function because each scenario's on-chain state feeds into the next.


| Scenario                        | Description                                                                                                                         |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| **t0 — Setup check**            | Verify assets exist, accounts are funded, contracts deployed correctly                                                              |
| **t1 — Local settlement**       | Bob places a BUY from AH, Dave places a SELL from AH at the same price → engine matches them → ERC-20 tokens swap on AH             |
| **t2 — Cross-chain order**      | PenpalA sends XCM Transact over HRMP (approve + placeLimitOrder) → order rests on the book                                         |
| **t3 — Cross-chain settlement** | Another XCM Transact BUY + Dave's local SELL → match → base tokens delivered to Charlie on PenpalA via XCM reserve transfer        |
| **t4 — Cross-chain cancel**     | XCM Transact places then cancels a resting order → refund `PendingClaim` created                                                   |


Two additional **standalone smoke tests** run independently:

- `hrmp_message_from_penpal_to_asset_hub_works`: basic XCM message delivery between parachains
- `xcm_transact_revive_call_on_asset_hub`: XCM Transact invoking `pallet_revive::call` on Asset Hub

## Actors


| Account            | Role                                                                                       |
| ------------------ | ------------------------------------------------------------------------------------------ |
| **Alice**          | Asset admin, contract deployer                                                             |
| **Bob**            | Local buyer on Asset Hub                                                                   |
| **Dave**           | Local seller on Asset Hub                                                                  |
| **Charlie**        | Cross-chain trader on PenpalA (para 2000)                                                  |
| **Sovereign 2000** | PenpalA's sovereign account on Asset Hub, executes cross-chain orders on behalf of Charlie |


## Network topology

The `xcm-emulator` runs everything in a single process:

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

## Setup sequence

1. Fund native balances on AH (Alice, Bob, Dave, sovereign of para 2000)
2. Create test assets: tUSD (id 100, quote) and tGOLD (id 101, base), and mint to participants
3. Register tGOLD as a foreign asset on PenpalA (needed for cross-chain settlement delivery)
4. Register accounts in `pallet_revive` via `map_account()`
5. Deploy contracts: RedBlackTree library → DLOB implementation → DLOBFactory
6. Create a tGOLD/tUSD market and set `minCrossChainFee`
7. Run t0 → t4 sequentially

## Implementation notes

- **Contract deployment** uses `pallet_revive::bare_instantiate` with CREATE2 (unique salts per deploy)
- **Local calls** use the `pallet_revive::Pallet::call` dispatchable inside `execute_with` blocks
- **Read-only queries** use `pallet_revive::bare_call` (e.g. `balanceOf`, `bestBid`)
- **Cross-chain orders** send real XCM programs from PenpalA over HRMP, containing `Transact` instructions that call `pallet_revive::call` on AH as the sovereign account — the same flow production parachains would use
- **Cross-chain settlement** is the full happy path: matched tokens are delivered to PenpalA via XCM reserve transfer (`DepositReserveAsset`), verified by checking `ForeignAssets` balance on PenpalA
- **ABI encoding** uses `alloy-sol-types`' `sol!` macro with the same Solidity function signatures as the contracts

