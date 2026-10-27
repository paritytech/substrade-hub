# Wallets

The trading UI reaches the same DLOB contracts on Asset Hub through three kinds of account:

- **EVM wallets** (MetaMask, or Talisman in EVM mode) sign an `eth_sendTransaction` through the
  network's eth-rpc.
- **Substrate wallets** (SubWallet, polkadot-js) sign a `pallet_revive.call` extrinsic via
  `polkadot-api` (PAPI).
- **Host accounts**: inside a Polkadot Triangle host (the Polkadot app, Polkadot Desktop, or a dot.li
  gateway such as testnet.li) the host provides the account and signs; see "Host / .dot mode" at the
  bottom.

All three drive the identical on-chain logic; only the signing path differs. This page covers what each
path needs and the messages you may hit.

Each transaction reports its progress in a toast: signed, submitted, included in a block, and confirmed
once that block is finalized. MetaMask signs and broadcasts in one step, so its progress starts at
submitted.

## Supported Substrate wallets

| Wallet | Status | Notes |
|--------|--------|-------|
| **SubWallet** | Supported | Honors the network metadata the app provides. Signed orders end to end on an earlier Asset Hub Next runtime; not yet re-tested on the current one. |
| **polkadot-js** | Expected to work | Same metadata mechanism as SubWallet; not tested end to end. |
| **Talisman** | Not supported (Substrate) | Talisman keeps its own chaindata registry and may ignore the metadata the app provides, so it can't encode this runtime's custom signed extensions. Use SubWallet or polkadot-js for Substrate signing. Talisman's EVM mode still works for the EVM path. |

### Why the metadata approval prompt appears

The Asset Hub Next runtimes carry **custom signed (transaction) extensions**: on previewnet `AsPgas`,
`AsDotnsGateway`, `RestrictOrigins` and others, on paseo-v2 `AuthorizeCall`, `EthSetOrigin` and
`StorageWeightReclaim`. The full list is the `USER_EXTENSIONS` table in
`src/lib/extension-metadata.ts`, which a test keeps in sync with each network's runtime metadata. A wallet that doesn't recognise these names silently drops them when it re-encodes the
transaction, signs the wrong bytes, and the chain rejects the signature with `BadProof`.

To prevent this, on first connect the app calls the wallet's `metadata.provide()` with a definition of
these extensions, so the wallet's registry can encode them correctly. **You will see a one-time
"approve metadata" prompt in the wallet the first time you connect (or after a runtime upgrade) —
approve it.** It is registered per network, so it does not prompt again afterward. If you decline, the
app cannot sign on this chain and will tell you to approve and retry.

## Troubleshooting

### "Your account needs PAS before you can trade"

Shown for any account (EVM, Substrate or host) whose native token balance is below 0.05. The native token
pays network fees and storage deposits, and receiving tUSD needs the account to exist, so with none
every write fails, including claiming test tUSD. Send the native token to the address the notice shows
(the SS58 address of a Substrate or host account, the H160 of an EVM account). The notice links the
network's faucet when `networks.json` has a `nativeFaucetUrl`; until the account is funded, the faucet
button reads "Add PAS to your account first".

### "MetaMask's network for chain id 420420417 is not …"

The test networks share chain id 420420417, so MetaMask can switch to a network it already knows under
that id that is a different chain. The app compares a recent block between MetaMask's RPC and its own
on connect and before every send, and stops on a mismatch. Edit that network in MetaMask so its RPC URL
is the one the message names, then retry.

### "You've already claimed" or "The faucet is out of test tokens right now"

The tUSD faucet dispenses a fixed amount once per account per cooldown (24 hours by default); the button
shows the time left. "Out of test tokens" means the faucet contract needs refilling by its operator.

### The wallet won't present a signing prompt (or signing seems stuck)

This is usually a stale wallet session (the connection was established before a reload, or the wallet
was locked/unlocked). **Disconnect and reconnect the account** in the app — that re-obtains a fresh
signer and re-registers the network metadata. This resolves most "it just won't let me sign" cases.

### "<wallet> can't register this network's signing extensions"

The wallet doesn't expose the metadata API, or ignores the provided definition (Talisman). Switch to
**SubWallet or polkadot-js**.

### "The transaction was rejected — check your token balance and approval, then try again"

The contract rejected the order before any transfer. The common causes:

- **You don't hold enough of the token being escrowed.** A sell escrows the base token; a buy escrows
  the quote token. Check your balance for the exact amount (a limit buy escrows `price x amount`).
- **Allowance too low.** Every order needs a prior `approve`. The app approves the amount the order
  escrows, and waits for that approval before it previews and sends the order.

### "Couldn't complete the transaction. Please try again."

The order passed its simulation but failed on chain, usually because the book changed in between. A
market order hands back what does not fill within its price limit, so only a market order with
**All or nothing** on reverts when less than its amount fills. The browser console shows the chain
error. Check Open Orders and your balances, then retry.

### A market order filled only part of its amount

Before sending a market order, the app prices it against the book and shows what you pay (or receive),
the average price, and a price limit: the worst price it reaches plus a 1% slippage tolerance, never
more than 10% from the best price. Orders resting beyond that 10% are not filled, so an order at an
extreme price cannot fill yours. The order carries exactly the limit shown, and the contract stops
matching there: if the book moved or holds only orders at worse prices, the rest of the amount is
returned unfilled. A buy approves only the amount times that limit. The form warns when the book
cannot fill the whole amount within 10% of the best price.

### "This order crosses more resting orders than one transaction can fill"

One transaction fills a bounded number of resting orders (6, fewer when settlement is cross-chain; see
[KNOWN_ISSUES.md](../../../KNOWN_ISSUES.md#8-one-transaction-fits-about-7-fills)). For an order that
crosses more, limit or market, the app says how many transactions it needs and, once you agree, places
it in parts, one signature each. Each part is sized to what a simulation says it fills, and every part
carries your price (the limit price, or the market order's price limit): orders arriving in between
change only how much a part fills, never the price. What a part did not place (the book moved after
its simulation) goes into the next one; if the order then needs more transactions than you agreed to,
the app asks again. The last part of a limit order rests what does not cross; a market order stops when
the amount has filled or nothing is left within its limit. Stopping midway, or rejecting a signature,
leaves what the earlier parts placed; the toast says what was not placed, and stays until you close it.
If a part goes through but the app cannot read what it placed, nothing more is sent: check Open Orders
and your balances before placing the rest.
One order goes in at most 10 transactions.

When the orders in front are expired, too small for what fits to reach the minimum order size, or your
own (see [below](#one-of-your-resting-orders-disappeared-after-you-placed-an-order-on-the-other-side)),
the app sends the order anyway, saying "Clearing expired, small or your own orders at the front of the
book". The transaction clears them, cancelling your own and returning their escrow, and returns the
rest; place the order again to fill it.

### "This order cannot fill all or nothing" (or "One transaction cannot fill all of this order")

A market order with **All or nothing** on fills the whole amount in one transaction, or nothing: the
app sends `minAmountOut` equal to the amount, and the contract reverts if less fills. Before signing,
the app simulates the order, and stops when it would fill less:

- **"The book lists only … within the price limit"**: the book holds less than the amount within the
  price limit (the best price plus 1% slippage, at most 10% from the best price).
- **"One transaction cannot fill all of this order"**: the book holds enough, but one transaction fills
  only a bounded number of resting orders (see
  [KNOWN_ISSUES.md](../../../KNOWN_ISSUES.md#8-one-transaction-fits-about-7-fills)), expired orders at
  the front included. An all-or-nothing order is never split across transactions.

Place a smaller amount, or turn All or nothing off to fill what one or more transactions can. If the
book changes between the check and the transaction, the transaction reverts and nothing fills.

### "No sell-side liquidity to fill this market order" (or "buy-side")

A market order fills against the **opposite** side of the book — a market buy takes asks, a market sell
takes bids. If that side is empty there is nothing to match: the contract fills nothing but **does not
revert**, so a naive submit would silently spend gas on a no-op. The app blocks this up front — the
order button is disabled with this message, and the place-order hook refuses to submit (a backstop if
the button is bypassed). **Place a limit order instead**: it rests on the book and becomes the
liquidity a later market order can take. The check reads the live best bid/ask (`getBestPrices`), so it
clears as soon as the other side has a resting order.

### "The connection to the host is lost" (or "Reconnecting to the host…")

Inside Polkadot Desktop or dot.li, the app reaches the chain and signs through the host. When that
channel drops, a banner under the header says so, and orders, cancels and claims are refused with "The
connection to the host is lost. Try again once it is back." instead of waiting at a signature that
cannot come. The banner goes away when the channel is back.

### "This post-only order would trade against the book, so it was not placed"

A limit order with **Post only** on only rests on the book; it never trades when it arrives. The
contract rejects it with `PostOnlyWouldCross` when its price reaches the best price on the other side:
a buy at or above the best ask, a sell at or below the best bid. The form says so before signing, from
the best prices it last read, and disables the button; the contract checks the book as it is when the
transaction runs. An expired order at the best price that nobody has removed yet still counts. Price
the order away from the other side, or turn Post only off.

### One of your resting orders disappeared after you placed an order on the other side

Self-trade prevention: an order that reaches one of your own resting orders cancels that resting order
and returns its escrow to you, then keeps matching against other traders' orders. Nothing trades between
your two orders. Open Orders drops the cancelled one, and your balance shows the escrow back.

### An order shows "Expired" in Open Orders

A limit order placed from the app expires 24 hours after it is sent (the form says so under the order),
unless it fills first. An expired order no longer fills, but it keeps its escrow until a match reaches
it, someone clears its price level, or you cancel it: **Cancel** returns the escrow straight away. Until
then the order book still counts it at its price (see
[KNOWN_ISSUES.md](../../../KNOWN_ISSUES.md#9-an-expired-order-stays-on-the-book-until-something-removes-it)).

## Developer notes

### The `pjs-signer` patch

The Substrate signer path depends on a small patch to `@polkadot-api/pjs-signer` (see `patches/` and
`pnpm-workspace.yaml`) that lets it defer unknown signed extensions to the wallet instead of throwing.
It is necessary but not sufficient — the wallet also needs the metadata definition above. Only wallets
that sign a payload (`signPayload`) go through it: for a wallet that builds the whole transaction
(`createTransaction`), pjs-signer uses that and never reaches the patched code.

### If you see "PJS does not support this signed-extension" in dev

This means the running build is using an **unpatched** copy of `@polkadot-api/pjs-signer` — almost
always a stale install or a stale Vite pre-bundle, not a code problem. Fix:

```bash
pnpm install                      # re-applies the patch to hoisted copies
rm -rf apps/trade/node_modules/.vite   # drop the stale dependency pre-bundle
# then FULLY restart the dev server (a running Vite holds the old bundle in memory;
# a browser reload alone is not enough)
```

### Where the logic lives

- `src/lib/extension-metadata.ts` — builds the metadata definition and the custom-extension `ExtDef`,
  and registers it with the wallet (`ensureExtensionMetadata`).
- `src/lib/substrate-wallet.ts` — extension discovery, connect, account watching.
- `src/lib/revive.ts` — dry-run, submit `Revive.call`, and format submission errors.
- `src/lib/errors.ts` — decode contract reverts (by 4-byte selector) into readable messages.

## Host / .dot mode (Polkadot Triangle)

The app can run as a Polkadot Triangle ".dot" app inside a host container (the Polkadot app, Polkadot
Desktop, a dot.li gateway such as testnet.li, or the local test harness). In host mode the app detects
the container, reaches the chain through the host, and the host signs orders; no browser extension is
involved.

- **Detection** (`src/lib/host/detect.ts`): `isInHost()` = `isInsideContainerSync()` from
  `@parity/product-sdk-host`. `VITE_USE_HOST_API=false` forces standalone (handy for local dev in a
  plain tab).
- **Chain client** (`src/lib/client.ts`): the network comes from `networks.json` (`VITE_NETWORK`). In
  host mode the app asks the host which Asset Hub it serves (`getHostChainInfo`) and refuses a different
  one, then connects through `getHostProvider(genesis)`; there is no direct RPC fallback inside a host.
  Both modes check the live genesis, so a reset chain fails with a clear message.
- **Account and signing** (`src/lib/host/signer.ts`): "Connect Wallet" offers **"Connect Polkadot
  account"**. A `SignerManager` (`@parity/product-sdk-signer`) resolves the app's product account,
  derived from the network's dotNS name, and its tx creator drives the same
  `writeContract` -> `submitReviveCall` path as the browser Substrate flow; the host builds and signs the
  extrinsic, so no `metadata.provide`/ExtDef is needed. The host derives the account from the
  signed-in user, so when the host has no session, Connect asks it to sign the user in (`requestLogin`).
  The host shows its own sign-in screen; on a dot.li gateway that is a QR code to scan with the Polkadot
  app. A declined sign-in shows "Sign-in was declined", and the app also connects by itself whenever the
  host reports a sign-in (`use-host-reconnect`). A host that does not answer a connect within 30
  seconds fails it with "The Polkadot host did not respond. Try again."
  Mapping is handled host-side, so the host path skips `ensureMapped`.
- **Username**: the account button shows the signed-in user's username from the host (`getUserId`),
  and the address when the host has none.
- **Permissions**: the app requests only the `Remote` grant below, and no resource allocation. The
  Android host sponsors gas by itself: when it signs a transaction made only of Revive calls, including
  one forwarded from a dot.li gateway, it tops up the product account's PGAS allowance first. A
  transaction that does not use a PGAS allowance pays its fees in the native token, as browser-wallet
  transactions do.
- **Native token**: a host may sponsor gas, never storage deposits, and a new product account holds no
  native token; see "Your account needs PAS before you can trade" above.
- **Network access** (`src/lib/host/remote.ts`): hosts block outbound HTTP unless the product holds the
  `Remote` permission for the domain. Trade history reads the network's eth-rpc, so the app requests it
  the first time history is fetched; `src/hooks/use-trade-history.ts` explains why history comes from
  eth-rpc.

### Try it in one command (test harness)

`@parity/host-api-test-sdk` provides a real host-protocol server that embeds the app and answers Host
API calls, with the product's account derived from `//Alice`. No Desktop install, no deploy:

```bash
VITE_NETWORK=previewnet pnpm dev          # terminal 1: Vite on http://localhost:5173
VITE_NETWORK=previewnet pnpm demo:host    # terminal 2: prints a URL; open it in any browser
```

The printed URL loads the app inside a host, reading the live order book and signing via the host
account. That account is derived from `//Alice` and starts with no funds, so fund it before trading
(`node contracts/scripts/bootstrap.mjs --network previewnet --only fund --fund <address>`).

### Try it in the real host

Type `http://localhost:5173` into the **Polkadot Desktop** address bar (same code, real Host API), or open
the published name in the Polkadot app on the matching network (see `docs/deploy.md`).
