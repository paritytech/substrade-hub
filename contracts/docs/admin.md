[← Back to README](../README.md)

# Admin powers

One account, the factory's `admin`, holds every privileged power in the system. Markets read it from
the factory that created them (`factory.admin()`), so it governs every market at once. This page lists
what that account can do, what a compromised key could do with it, and how custody should be handled
before a production deployment.

It describes the current contracts, which previewnet runs. paseo-v2's factory and markets predate the
two-step transfer, the fee bounds and the halt flag (#105, #106), and keep the previous behaviour until
its next contract deployment: a one-step `transferAdmin`, no bounds, no `setHalted`.

## What the admin can do

| Power | Where | What it does | What a compromised key could do |
|---|---|---|---|
| `createMarket` | `DLOBFactory.sol` | Lists a market for a token pair, with its tick, minimum and maximum order size. | List markets for look-alike or worthless tokens. The app only shows markets quoted in the known quote token whose tokens share decimals. |
| `setMinCrossChainFee` | `DLOBFactory.sol` | Sets the DOT fee reserve a cross-chain order must carry, at most 10 DOT (`MAX_MIN_CROSS_CHAIN_FEE`). | Raise it to the cap, making cross-chain orders dearer. |
| `setMarketCreationDeposit` | `DLOBFactory.sol` | Sets the deposit for a new market, at most 1,000 DOT. | Nothing beyond the admin's own market creation, which it controls anyway. |
| `transferAdmin` / `acceptAdmin` | `DLOBFactory.sol` | Hands every power on this page to another account, in two steps: the new account must call `acceptAdmin`. `transferAdmin(address(0))` cancels. | Hand the role to an account it controls. A mistyped address cannot receive it. |
| `setHalted` | `DLOBFactory.sol` | Stops (or resumes) new orders on every market. Cancelling, reducing, claiming and withdrawing stay open. | Stop all trading until it is resumed. Users can still take their orders and funds out. |
| `adminRedirectClaim` | `DLOB.sol` | Sends any pending claim to any parachain and beneficiary. | **Redirect every pending claim to itself.** This is the largest power in the system. |
| `sweepOrphanedDot` | `DLOB.sol` | Sends a market's DOT above its fee reserves to any recipient. | Take that excess DOT. Fee reserves backing open orders are excluded (`totalFeeReserveBalance`). |

What the admin **cannot** do: cancel or change other users' orders, move the tokens escrowed for
resting orders, change a market's code (markets are immutable EIP-1167 clones of one
implementation), or stop users from cancelling, reducing, claiming or withdrawing, even while
halted.

## Pending claims and `adminRedirectClaim`

A pending claim exists only when an inline XCM settlement failed (see
[how it works](how-it-works.md#pendingclaim-fallback)). Its owner can retry it with `claimSettlement`
or move it to another parachain with `redirectClaim`, which keeps the beneficiary. Only
`adminRedirectClaim` can change the beneficiary, for a claim that cannot be delivered anywhere else.

Cross-chain trading is not live yet (#15), so no pending claims exist on the deployed networks. Once it
is, `adminRedirectClaim` becomes the main custody risk.

## Custody

- **Test networks:** the admin is the bootstrap's deployer key. On paseo-v2 it is derived from the CI
  deploy mnemonic (see [paseo-v2: one secret](../../apps/trade/docs/deploy.md#paseo-v2-one-secret)); on
  previewnet it is a key the local bootstrap generated.
- **Before mainnet:** hand the admin role to an account that never enters CI, such as a multisig (check
  that a Safe deployment is available on Asset Hub), as part of the first deployment.
- **Root governance** through the System precompile is not an option for now: `callerIsRoot` and
  `callerIsOrigin` read the wrong call frame (paritytech/polkadot-sdk#13412), and markets run behind
  delegatecall.
