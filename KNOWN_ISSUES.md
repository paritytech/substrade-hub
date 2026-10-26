# Known issues

SubsTrade Hub carries a few known limitations and accepted trade-offs. Each links the issue or document
where it is tracked; this file is the index. For how to report a vulnerability, and the security status
of the code, see [SECURITY.md](SECURITY.md).

| # | Limitation | Area | Tracked in |
|---|---|---|---|
| 1 | One admin key holds every privileged power | Contracts | [Admin powers](contracts/docs/admin.md), #100, #105 |
| 2 | Cross-chain order ownership relies on a caller-supplied `originAccount` | Contracts | #60 |
| 3 | Failed cross-chain settlement waits as a pending claim | Contracts | [How it works](contracts/docs/how-it-works.md#pendingclaim-fallback) |
| 4 | Orders placed through a host or Substrate wallet are missing from eth-rpc's log index | App | below |
| 5 | Markets whose base and quote decimals differ are not shown | App | #79 |
| 6 | Demo networks use demo keys | Deployment | below |
| 7 | The Paseo networks share one EIP-155 chain id | Deployment | below |
| 8 | One transaction fits about 7 fills | Contracts | #104 |
| 9 | An expired order stays on the book until something removes it | Contracts | below |

## 1. One admin key holds every privileged power

The factory's `admin` can list markets, set fees, redirect any pending claim and sweep excess DOT, and
markets cannot be upgraded. The full list, and what a compromised key could do, is in
[Admin powers](contracts/docs/admin.md). The role moves in two steps and both fees are bounded (#105).
Custody before mainnet is open (#100).

## 2. Cross-chain order ownership relies on a caller-supplied `originAccount`

`cancelOrder`, `reduceOrder` and `redirectClaim` authorise the caller by `msg.sender` plus an
`originAccount` argument the contract cannot verify. That is safe while each trader has their own
`msg.sender`, and unsafe for integrations that place orders for many users from one parachain
sovereign account. Cross-chain trading is not live; the ownership model is to be settled before it is
(#60, which blocks #15).

## 3. Failed cross-chain settlement waits as a pending claim

When inline XCM delivery fails, the settlement is kept as a `PendingClaim` on Asset Hub instead of
reverting the trade. Funds stay on Asset Hub; anyone can retry with `claimSettlement`, and the owner
can move it with `redirectClaim`. An order with pending claims cannot be cancelled until they are
settled.

## 4. Orders placed through a host or Substrate wallet are missing from eth-rpc's log index

pallet-revive's eth-rpc indexes logs from `Revive.eth_transact` transactions only, so events from
`Revive.call` (how hosts and Substrate wallets submit) never reach `eth_getLogs`. The app works
around it:

- **Open Orders** scans order ids, bounded per poll, and fills in skipped ranges over later polls
  (#57, #81).
- **Trade history** reads eth-rpc's logs and scans the last 200 blocks on chain. Trades signed through a
  host or Substrate wallet that are older than that are not shown (#82).
- **Portfolio values** on Home use the last trade in eth-rpc's logs only, without that scan, so a trade
  signed through a host or Substrate wallet after it does not move a token's value.

## 5. Markets whose base and quote decimals differ are not shown

The DLOB prices in raw units, and the app shows a raw price as a human price, which only holds when
both tokens share decimals. The app skips any other market, and any market whose quote no longer has
the decimals recorded in `networks.json` (#79). Supporting such markets means scaling every price shown
and entered.

## 6. Demo networks use demo keys

The bootstrap that stages the demo markets is demo tooling. On previewnet, the test assets' owner is
`//Alice`, a public development key, so anyone can mint, burn or change those assets there. On
paseo-v2, one CI secret holds the deploy key, the test assets' admin and the factory admin. Both are
accepted for demo networks; see #83 for how the bootstrap keeps that secret out of build tools.

## 7. The Paseo networks share one EIP-155 chain id

Paseo Asset Hub Next and Paseo Asset Hub Previewnet both use chain id 420420417, set by their runtimes.
An EVM transaction signed through MetaMask for one is also valid on the other. Nothing the app signs
has an effect when replayed, because the contracts have different addresses on each network; at most
it uses gas and the sender's nonce on the other network. Transactions signed through a host or
Substrate wallet are bound to the network's genesis and are not affected.

## 8. One transaction fits about 7 fills

Each fill needs about 1 MB of proof, and one transaction may use 8 MiB, so an order that would fill
against more than about 7 resting orders cannot be included. The contracts now limit matching to a
per-transaction budget (`MATCH_BUDGET`, #104): 6 local fills, 4 when one leg of each fill settles
cross-chain, or 3 when both do. A full budget uses at most 75.2% of the proof limit
([benchmarks](contracts/docs/benchmarks.md)). A larger order fills what fits and returns the remainder: a limit order
cannot rest it at its price without crossing the book. `placeLimitOrder` reports that amount, and the
app checks it before signing: for an order that needs more than one transaction, limit or market, it
offers to place it in parts, one signature each (#107). Cancelling the trader's own resting orders,
which an order does when it meets them (#134), counts toward the budget like an expired-order cleanup.
When expired, small or the trader's own orders at the front of the book use up the budget, so that what
fits is too small to place, the app sends the order anyway: it clears them and returns the rest, to be
placed again. A market order sent with "All or nothing" (#133) is never split: it must fill within one
transaction's budget, or it does not go in.

## 9. An expired order stays on the book until something removes it

The DLOB has no keeper: an expired order is removed when a match reaches it, when `purgeExpired` clears
its price level, or when its owner cancels it, and only then is its escrow returned. Until then the
order book counts it at its price. Limit orders placed from the app expire after 24 hours (#132), so
Open Orders keeps listing an expired order, marked "Expired", with its Cancel button, which returns the
escrow. Orders the bootstrap seeds never expire.
