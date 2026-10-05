# Deploying as a Polkadot Triangle (".dot") app

SubsTrade Hub publishes per network as a `.dot` app. Each network in
[`src/config/networks.json`](../src/config/networks.json) names its dotNS name (`dotnsName`) and the
[`bulletin-deploy`](https://www.npmjs.com/package/bulletin-deploy) environment that publishes to it
(`bulletinDeployEnv`).

| Network | dotNS name | Web gateway | `bulletin-deploy --env` |
|---|---|---|---|
| previewnet | `substrade-hub.testnet` | `https://substrade-hub.testnet.li` | `preview` |

The app runs the **same** build in-host and standalone; host mode is auto-detected (see `wallets.md`).
The contracts the build talks to come from the same `networks.json` entry, so bootstrap the network
first (`contracts/scripts/bootstrap.mjs`, see the root README).

## How a publish works

`scripts/deploy-dot.mjs` runs a pinned `bulletin-deploy` with the network's environment. It:

1. uploads `dist/` to the network's Bulletin chain. bulletin-deploy stores through its own pool
   accounts and authorizes them itself where the environment allows it (on previewnet the authorizer is
   `//Eve`), so the owner account needs no Bulletin authorization;
2. registers the dotNS name for the owner account when the name is free (a 5 PAS storage deposit on
   previewnet), and otherwise requires the owner to already hold it;
3. writes the root manifest (display name, description, icon) and the app's executable manifest, with
   `appVersion` from `APP_VERSION`, from `bulletin-deploy.config.ts`.

`substrade-hub` (13 characters, no trailing digits) is self-registrable on every dotNS generation, so
registration needs no proof of personhood.

## The owner account

The owner is the account whose mnemonic is passed as `MNEMONIC`. It must hold native PAS on the
network's Asset Hub; fund it from the bootstrap funder with
`node contracts/scripts/bootstrap.mjs --network <name> --only fund --fund <ss58>`.

| Network | Owner |
|---|---|
| previewnet | `5CfNK8oFBuZReoEsYpMeztkrvMGZic1uJTzbSKQK7nvVYnbb` |

## CI publish

`.github/workflows/deploy-dot.yml` builds and publishes on manual dispatch (choose the network and a
required `version`) or on a `dot-v*` tag, which publishes to previewnet with the version from the tag.

- **One environment per network.** In repo Settings > Environments, create `<network>-deploy` (for
  previewnet: `previewnet-deploy`), restrict its deployment branches and tags to `master` and `dot-v*`,
  store the owner's mnemonic there as the environment secret **`DOTNS_MNEMONIC`**, and its SS58 address
  as the environment variable **`DOTNS_OWNER`**. The publish refuses to run unless the mnemonic derives
  that address.
- **After a testnet reset**, bootstrap the network again, then rerun the workflow by hand: it
  re-registers the name and republishes.
- **Pinned CLI.** The publish step runs `bulletin-deploy@0.22.0` because it handles the mnemonic; bump the
  pin in `scripts/deploy-dot.mjs` deliberately after reviewing a release.

## Manual publish

```bash
cd apps/trade
VITE_NETWORK=previewnet pnpm build
VITE_NETWORK=previewnet APP_VERSION=1.0.0 MNEMONIC="<owner mnemonic>" \
  DOTNS_OWNER=5CfNK8oFBuZReoEsYpMeztkrvMGZic1uJTzbSKQK7nvVYnbb pnpm deploy:dot
```

`DOTNS_OWNER` is optional locally and required in CI.

`APP_VERSION` is **required**: the config throws if it is missing or malformed, to prevent an
unversioned publish. `MNEMONIC` is read from the environment, so it never appears in process arguments;
never commit it.

## Files in this setup

- `apps/trade/bulletin-deploy.config.ts`: product manifest (domain from `networks.json`, display name,
  description, icon, `executables`/`appVersion`).
- `apps/trade/scripts/deploy-dot.mjs`: runs the pinned `bulletin-deploy` for `VITE_NETWORK`.
- `apps/trade/icon.svg` / `icon.png`: app icon (PNG is generated from the SVG; the config references the PNG).
- `apps/trade/public/{manifest.webmanifest,icon-192.png,icon-512.png,favicon-32.png}`: PWA manifest + icons.
- `.github/workflows/deploy-dot.yml`: CI publish.

## Known caveat

Candle history (`use-trade-history`) fetches via a direct `eth_getLogs` to the network's `rpcUrl`, not
the host-routed client. If a strict host or gateway blocks that direct call, the chart may be empty while
trading still works.
