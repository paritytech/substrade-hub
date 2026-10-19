[← Back to README](../README.md)

# Admin powers

One account, the factory's `admin`, holds every privileged power in the system. Markets read it from
the factory that created them (`factory.admin()`), so it governs every market at once. This page lists
what that account can do, what a compromised key could do with it, and how custody should be handled
before a production deployment.

## What the admin can do

| Power | Where | What it does | What a compromised key could do |
|---|---|---|---|
| `createMarket` | `DLOBFactory.sol` | Lists a market for a token pair, with its tick, minimum and maximum order size. | List markets for look-alike or worthless tokens. The app only shows markets quoted in the known quote token whose tokens share decimals. |
| `setMinCrossChainFee` | `DLOBFactory.sol` | Sets the DOT fee reserve a cross-chain order must carry. | Set it high enough to make cross-chain orders unaffordable, pushing settlement into pending claims. It has no upper bound yet (#105). |
| `setMarketCreationDeposit` | `DLOBFactory.sol` | Sets the deposit for a new market. | Nothing beyond the admin's own market creation, which it controls anyway. |
| `transferAdmin` | `DLOBFactory.sol` | Hands every power on this page to another account, in one step. | Take the role for good. A mistyped address loses it for good too (#105 makes it two-step). |
| `adminRedirectClaim` | `DLOB.sol` | Sends any pending claim to any parachain and beneficiary. | **Redirect every pending claim to itself.** This is the largest power in the system. |
| `sweepOrphanedDot` | `DLOB.sol` | Sends a market's DOT above its fee reserves to any recipient. | Take that excess DOT. Fee reserves backing open orders are excluded (`totalFeeReserveBalance`). |

What the admin **cannot** do: cancel or change other users' orders, move the tokens escrowed for
resting orders, change a market's code (markets are immutable EIP-1167 clones of one
implementation), or stop users from cancelling, reducing, claiming or withdrawing.

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
