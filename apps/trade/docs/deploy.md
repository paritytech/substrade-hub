# Deploying as a Polkadot Triangle (".dot") app

SubsTrade Hub publishes to the Polkadot Products Devnet as a `.dot` app. Once published it is reachable at:

- `substrade-hub.dot` inside the Polkadot app (Desktop / Web / Mobile hosts)
- `https://substrade-hub.dev-dot.li` on the web gateway

The app runs the **same** build in-host and standalone; host mode is auto-detected (see `wallets.md`).

## Scope: this is the Products Devnet deployment

The target is the **Polkadot Products Devnet** (`--env devnet`, gateway `dev-dot.li`) — the current
showcase network, where our DLOB contracts are already deployed. Issue #22's Task 3 text says
`substrade-hub.dot.li` / `paseo-next-v2`; that naming is **stale** (as with Tasks 1 and 2). A production
deployment
(a non-devnet network / the `.dot.li` gateway) is a **separate** effort that would first require
redeploying the DLOB contracts to that network and repointing `activeChain` (`src/config/chains.ts`) at
it; the hard-coded contract addresses here are Devnet-specific. Do not treat this workflow as the
production release.

## What is already done (one-time)

- **Name registered:** `substrade-hub.dot` is owned by `5FvUTdBQYw1LXJ9AHAgwnfZVm56H4fjWCbZrbpZV51Hupo1J`
  (EVM `0x2D7E83B2c28B2d72f34F2C87865Fa8571030D9db`). Verify: `dotns lookup owner-of substrade-hub --env devnet`.
- **Chain check:** `--env devnet` resolves to `wss://asset-hub-paseo-rpc.n.dwellir.com` (Products Devnet =
  Paseo Asset Hub), the same chain `activeChain.genesis` pins and the host routes to — so the published app
  finds the deployed DLOB contracts. No contract redeploy / CDM needed (we call contracts by address with
  viem ABIs, not the on-chain ContractRegistry).

## Prerequisites for the deploy account

`pad` writes the name's content record, so the publishing account must **own `substrade-hub.dot`** — not
merely be funded. Today the owner is `5FvUTdBQYw1LXJ9AHAgwnfZVm56H4fjWCbZrbpZV51Hupo1J`
(`0x2D7E83B2c28B2d72f34F2C87865Fa8571030D9db`), so the deploy mnemonic must derive that account. To
publish from a dedicated CI account instead, first transfer the name to it (`dotns` ownership transfer);
"any funded, mapped, authorized account" is **not** sufficient.

The owning account must also, on Devnet Asset Hub:

1. Be **funded** with native PAS (devnet faucet).
2. Be **EVM-mapped**: `dotns account map --env devnet`.
3. Hold a **Bulletin storage authorization** (bundles upload to the Bulletin chain):
   ```bash
   dotns bulletin authorize <ss58> --transactions 1000 --bytes 104857600 --env devnet
   ```

Tooling (Node 22+), pinned to reviewed releases:
`npm i -g @polkadot-community-foundation/dotns-cli @polkadot-community-foundation/polkadot-app-deploy@0.13.1`.

## Manual publish

```bash
cd apps/trade
pnpm build                                   # produces dist/  (vite base is "./", gateway-safe)
export DOTNS_MNEMONIC="<owner account mnemonic>"    # must own substrade-hub.dot; never commit this
export APP_VERSION="1.0.0"                           # published as appVersion; bump per release
pad ./dist substrade-hub.dot --env devnet --mnemonic "$DOTNS_MNEMONIC"
dotns content view substrade-hub --env devnet       # verify the content record / CID
```

`pad` uploads `dist/` to Bulletin and writes the name's root manifest record in one step, reading metadata
(display name, icon, and `APP_VERSION`) from `polkadot-app-deploy.config.ts`. `APP_VERSION` is **required**:
the config throws if it is missing or malformed, to prevent an accidental unversioned publish. Do **not**
pass `--publish` (public registry listing needs proof of personhood, which the CLI can't do).

## CI publish

`.github/workflows/deploy-dot.yml` builds and publishes on manual dispatch (with a required `version`
input) or a `dot-v*` tag (from which the version is derived), so each release publishes a distinct
`appVersion`. Notes:

- **Create the `devnet-deploy` environment first (one-time).** In repo Settings > Environments, create
  an environment named `devnet-deploy`, add required reviewers / branch restrictions, and store
  **`DOTNS_MNEMONIC`** there as an **environment secret** (not a repo secret). Declaring
  `environment: devnet-deploy` in the workflow does **not** create the environment or move any secret; the
  workflow's fail-fast check will error until this exists. The mnemonic must derive the **owner** of
  `substrade-hub.dot` (see prerequisites); to keep a personal seed out of CI, transfer the name to a
  dedicated deploy account and use that account's mnemonic.
- **Pinned CLI.** The publish step runs `polkadot-app-deploy@0.13.1` (not `@latest`) because it handles the
  mnemonic; bump the pin deliberately after reviewing a release.
- Devnet may reset between builds, so re-check funding / mapping / Bulletin authorization if a run fails.

## Files in this setup

- `apps/trade/polkadot-app-deploy.config.ts` — `pad` metadata (domain, display name, description, icon,
  `executables`/`appVersion`). Bump `appVersion` per release.
- `apps/trade/icon.svg` / `icon.png` — app icon (PNG is generated from the SVG; the config references the PNG).
- `apps/trade/public/{manifest.webmanifest,icon-192.png,icon-512.png,favicon-32.png}` — PWA manifest + icons.
- `.github/workflows/deploy-dot.yml` — CI publish.

## Known caveat

Candle history (`use-trade-history`) still fetches via a direct `eth_getLogs` to `activeChain.rpcUrl`, not
the host-routed client. If a strict host/gateway blocks that direct call, the chart may be empty while
trading still works; routing candles through the host client is a tracked follow-up.
