# Wallets

The trading UI supports two account families against the same DLOB contracts on Asset Hub:

- **EVM wallets** (MetaMask, or Talisman in EVM mode) sign an `eth_sendTransaction` through the eth-rpc
  proxy.
- **Substrate wallets** (SubWallet, polkadot-js) sign a `pallet_revive.call` extrinsic via
  `polkadot-api` (PAPI).

Both drive the identical on-chain logic; only the signing path differs. This page covers the Substrate
path, which has runtime-specific requirements, and the issues you may hit.

A third mode, **host mode**, runs the app inside a Polkadot Triangle host (Polkadot Desktop / dot.li);
see "Host / .dot mode" at the bottom.

## Supported Substrate wallets

| Wallet | Status | Notes |
|--------|--------|-------|
| **SubWallet** | Supported (verified) | Honors the network metadata the app provides; signs orders end-to-end. |
| **polkadot-js** | Supported | Reference extension; same behavior as SubWallet. |
| **Talisman** | Not supported (Substrate) | Talisman keeps its own chaindata registry and may ignore the metadata the app provides, so it can't encode this runtime's custom signed extensions. Use SubWallet or polkadot-js for Substrate signing. Talisman's EVM mode still works for the EVM path. |

### Why the metadata approval prompt appears

Paseo "Asset Hub Next" carries several **custom signed (transaction) extensions**
(`AuthorizeValueTransfer`, `AsPgas`, `AsRingAlias`, and others). A wallet that doesn't recognise these
names silently drops them when it re-encodes the transaction, signs the wrong bytes, and the chain
rejects the signature with `BadProof`.

To prevent this, on first connect the app calls the wallet's `metadata.provide()` with a definition of
these extensions, so the wallet's registry can encode them correctly. **You will see a one-time
"approve metadata" prompt in the wallet the first time you connect (or after a runtime upgrade) —
approve it.** It is registered per network, so it does not prompt again afterward. If you decline, the
app cannot sign on this chain and will tell you to approve and retry.

## Troubleshooting

### The wallet won't present a signing prompt (or signing seems stuck)

This is usually a stale wallet session (the connection was established before a reload, or the wallet
was locked/unlocked). **Disconnect and reconnect the account** in the app — that re-obtains a fresh
signer and re-registers the network metadata. This resolves most "it just won't let me sign" cases.

### "This wallet can't register this network's signing extensions"

The wallet doesn't expose the metadata API, or ignores the provided definition (Talisman). Switch to
**SubWallet or polkadot-js**.

### "Transaction reverted with no reason (commonly an insufficient token balance or allowance)"

The contract rejected the order before any transfer. The common causes:

- **You don't hold enough of the token being escrowed.** A sell escrows the base token; a buy escrows
  the quote token. Check your balance for the exact amount (a limit buy escrows `price x amount`).
- **Allowance not yet set.** Every order needs a prior `approve`. The app approves automatically, but if
  the approve is still confirming when the order previews, the preview can fail; retry after a moment.

### "Transaction failed: Module (Revive.ContractReverted)" on a market order

The order passed the pre-flight simulation but the contract reverted at execution. This is a
**market-order race**: the order book moved (another trade filled the level you were going to match, or
it became your own resting order) between the preview and when your transaction actually ran. It is not
a signing problem, and it affects the EVM path identically.

- Retry — the book may have settled.
- Prefer a **limit order that rests** (a sell priced above the best bid, a buy priced below the best
  ask). A resting order does not match against the other side, so it has no race and no self-trade risk.

### "Cannot trade against your own resting order"

Self-trade prevention: your incoming order would match an order you already have resting on the book.
Cancel the resting order first, or use a different account.

## Developer notes

### The `pjs-signer` patch

The Substrate signer path depends on a small patch to `@polkadot-api/pjs-signer` (see `patches/` and
`pnpm-workspace.yaml`) that lets it defer unknown signed extensions to the wallet instead of throwing.
It is necessary but not sufficient — the wallet also needs the metadata definition above.

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

The app can run as a Polkadot Triangle ".dot" app inside a host container (Polkadot Desktop webview,
dot.li iframe, or the local test harness). In host mode the app detects the container and routes chain
access through the host instead of a browser wallet. **Chain reads work in host mode today; host-side transaction signing is not yet wired up.**

- **Detection** (`src/lib/host/detect.ts`): `isInHost()` = `isInsideContainerSync()` from
  `@parity/product-sdk-host`. `VITE_USE_HOST_API=false` forces standalone (handy for local dev in a
  plain tab).
- **Chain client** (`src/lib/client.ts`): in host mode reads go through the sanctioned, host-routed
  `createChainClient` (`@parity/product-sdk-chain-client`) — **no RPC endpoint; the descriptor's genesis
  selects the chain** — gated by `isChainSupported(genesis)` so an unsupported chain fails fast. It
  reuses our full `passet_hub` descriptor, so `client.assetHub` is the same `TypedApi` the rest of the
  app already uses (`ReviveApi.call`/`eth_transact` intact). Standalone connects directly by WS. Both
  paths run once at boot via `initChainClient()`, gated by `ChainBoot` so data hooks wait for the
  client. This mirrors the official `playground-app-template`.

### Try it in one command (test harness)

`@parity/host-api-test-sdk` provides a real host-protocol server that embeds the app and answers Host
API calls with a funded dev account (alice) — no Desktop install, no deploy:

```bash
pnpm dev          # terminal 1: Vite on http://localhost:5173
pnpm demo:host    # terminal 2: prints a URL — open it in any browser
```

The printed URL loads the app inside a host, reading the live order book. (The dev account holds no
tUSD/tNVDA, so trading isn't exercised here — this mode is for chain reads.)

### Try it in the real host

Type `http://localhost:5173` into the **Polkadot Desktop** address bar — same code, real Host API.
