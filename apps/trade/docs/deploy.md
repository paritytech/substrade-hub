# Deploying as a Polkadot Triangle (".dot") app

SubsTrade Hub publishes per network as a `.dot` app. Each network in
[`src/config/networks.json`](../src/config/networks.json) names its dotNS name (`dotnsName`) and the
[`bulletin-deploy`](https://www.npmjs.com/package/bulletin-deploy) environment that publishes to it
(`bulletinDeployEnv`).

| Network | dotNS name | Web gateway | `bulletin-deploy --env` |
|---|---|---|---|
| previewnet | `substrade-hub.testnet` | `https://substrade-hub.testnet.li` | `preview` |
| paseo-v2 | `substrade-hub.paseo` | `https://substrade-hub.paseo.li` | `paseo-next-v2` |

The app runs the **same** build in-host and standalone; host mode is auto-detected (see `wallets.md`).
The contracts the build talks to come from the same `networks.json` entry, so bootstrap the network
first (`contracts/scripts/bootstrap.mjs`, see the root README). A publish refuses a network whose
`factoryAddress` is still the zero address.

## Opening the published app

- **In a browser**: the web gateway in the table above. It is itself a host, so sign in there to trade.
- **In the Polkadot app**: each build of the app serves one network, fixed when it is built, and resolves
  only that network's names. Use a build that serves the network you published to, and open the dotNS
  name (for example `substrade-hub.testnet`) in its in-app browser.

### Links into the app

The app keeps its view in the URL hash: `#/market/<address>` opens a market, `#/orders` the Open Orders
panel, and `#/` (or no hash) Home. A link such as
`https://substrade-hub.testnet.li/#/market/0x061e335df39B6478A3e830F91A0413a18d60d0e4` reaches the app
through the gateway, which hands the hash to the app's frame. Inside a gateway the app runs in that
frame, so moving between markets updates the frame's history (Back works) but not the address bar,
which keeps the link that was opened. A link to a market the network does not list, or one cut short
before the full address, opens another market, with a notice.

## How a publish works

`scripts/deploy-dot.mjs` runs a pinned `bulletin-deploy` with the network's environment. It:

1. uploads `dist/` to the network's Bulletin chain. bulletin-deploy stores through its own pool
   accounts and authorizes them itself where the environment allows it (the authorizer is `//Eve` on
   previewnet and `//Alice` on paseo-v2), so the owner account needs no Bulletin authorization;
2. registers the dotNS name for the owner account when the name is free (a 5 PAS storage deposit on
   both networks), and otherwise requires the owner to already hold it;
3. writes the root manifest (display name, description, icon) and the app's executable manifest, with
   `appVersion` from `APP_VERSION`, from `bulletin-deploy.config.ts`.

`substrade-hub` (13 characters, no trailing digits) is self-registrable on every dotNS generation, so
registration needs no proof of personhood.

## The owner account

The owner is the account whose mnemonic is passed as `MNEMONIC`. It must hold native PAS on the
network's Asset Hub. On previewnet, fund it from the bootstrap funder with
`node contracts/scripts/bootstrap.mjs --network previewnet --only fund --fund <ss58>`. On paseo-v2 the
owner is also the bootstrap funder (see "paseo-v2: one secret" below), so fund it from the faucet
(`nativeFaucetUrl`).

| Network | Owner |
|---|---|
| previewnet | `5CfNK8oFBuZReoEsYpMeztkrvMGZic1uJTzbSKQK7nvVYnbb` |
| paseo-v2 | `5DJjEEsTvRUibZm5JzBPYfiH6d3QJ6SbPnMTK7eMdWvwFPt2` |

## Deployed contracts

The app reads the factory, faucet and tUSD addresses from `networks.json`; this table also lists the
markets and the other test tokens. The tokens are pallet-assets precompiles, with the same asset ids
(tUSD 50000698, tNVDA 50000699, tMU 50001034) on both networks. The admin is the bootstrap's deployer
key: it administers the factory and owns the tUSD faucet.

| Contract | previewnet | paseo-v2 |
|---|---|---|
| DLOB factory | `0x9Ad335cBEC61eFBeb8d24f98A25A4Ba35E62B901` | `0x8F9fb859F4EA7ae26BC97079DD3c2b7e9154dF51` |
| tNVDA/tUSD market | `0xF1889871553358b67Ca1133A4aD2e5A918C2B5Ec` | `0x65637ceb2881b976C4c53Be3C5AEd62ea939915d` |
| tMU/tUSD market | `0x061e335df39B6478A3e830F91A0413a18d60d0e4` | `0x1544677E2121C53a9D1ABBf92a1107F419384EF0` |
| tUSD faucet | `0xc675887d5eb476ea482c243067f6850263051e81` | `0xe1bc9e4b52ce0ee2950d14737ebd673a78d6860f` |
| tUSD token | `0x02faf33a00000000000000000000000001200000` | `0x02faf33a00000000000000000000000001200000` |
| tNVDA token | `0x02faf33b00000000000000000000000001200000` | `0x02faf33b00000000000000000000000001200000` |
| tMU token | `0x02faf48a00000000000000000000000001200000` | `0x02faf48a00000000000000000000000001200000` |
| Admin | `0x1FF54d6d9Ad6d7533Dedd0d430156a0F385ad5Df` | `0xa2b6183fBb377fB2079749a4dC0221774d179627` |

## Releases

A release publishes the same version to every network in `networks.json`. To make one, push a
`dot-vX.Y.Z` tag on a commit of `master`:

```bash
git fetch origin && git tag dot-v1.3.0 origin/master && git push origin dot-v1.3.0
```

Only admins and maintainers can push a `dot-v*` tag (the "Protect dot-v release tags" ruleset). The
tag starts `.github/workflows/release.yml`, which:

1. checks that the tag is `dot-vMAJOR.MINOR.PATCH`, points at a commit of `master`, and is newer than
   the previous release;
2. publishes every network through `deploy-dot.yml`, in parallel, with the version from the tag;
3. once every network has published, creates the GitHub Release (see below).

If a network fails, the GitHub Release is not created: rerun the failed jobs of the run, and the
release follows once they pass.

### Release notes and assets

`apps/trade/scripts/release/notes.mjs` reads every network back from the chain and writes:

- the notes header: where the release is live (each dotNS name, its dot.li link and the CID its
  contenthash points at) and whether the contracts changed since the previous release;
- `release-manifest.json`: the version, the commit and, per network, the dotNS name, gateway URL,
  CID, eth-rpc URL and dotNS content resolver;
- `deployments.json`: per network, the factory, implementation, linked libraries, faucet, quote token
  and every market the factory lists;
- `codehashes.json`: the codehash of each deployed contract in this release's build, with the parts that
  differ per deployment masked (linked library addresses, immutables, the CBOR metadata), so one hash
  holds on every network; plus the build settings (solc, EVM version, `via_ir`, optimizer);
- `abis.json`: the DLOB's and the factory's ABIs in this release's build, to build a client against.

The header also says whether every network runs the contract code this release builds, or names the
networks where a contract redeploy is pending, and lists the ABI changes since the previous release:
removed or changed functions, events and errors as breaking, additions collapsed. It compares with the
previous release's `abis.json`, or with its `apps/trade/src/abi/` files for a release made before that
asset existed.

GitHub's notes for the merged PRs follow the header, and the files above are attached to the release. To
add highlights or breaking changes, commit `release-notes/<version>.md` before tagging: its text goes
above the header.

### Verifying a release

```bash
pnpm install --frozen-lockfile
node apps/trade/scripts/release/verify.mjs --tag dot-v1.3.0
```

It downloads the release's three files with `gh`, then checks each network: the dotNS name points at
the release's CID; the factory lists the recorded markets; the implementation, factory, libraries and
faucet run the release's code (by masked codehash); and every market is the 45-byte EIP-1167 proxy to
the implementation, returned by the factory for its pair. A later release moves the
names to a newer build, so an older release then fails the CID check.

## CI publish

`.github/workflows/deploy-dot.yml` publishes one network. Run it by hand (choose the network and a
required `version`), for example to restore the name after a testnet reset; `release.yml` calls it for
every network.

- **One environment per network.** In repo Settings > Environments, create `<network>-deploy`
  (`previewnet-deploy`, `paseo-v2-deploy`), restrict its deployment branches and tags to `master` and
  `dot-v*` (a release runs on the tag), store the owner's mnemonic there as the environment secret
  **`DOTNS_MNEMONIC`**, and its SS58 address as the environment variable **`DOTNS_OWNER`**. The publish
  refuses to run unless the mnemonic derives that address.
- **After a testnet reset**: the chain has a new genesis. The app and the bootstrap refuse a live genesis
  that differs from `networks.json`, and the build refuses a `networks.json` genesis that differs from
  its `.papi` entry. So:
  1. refresh the chain types: `pnpm exec papi update <papiEntry>` in `apps/trade`, which also records the
     new genesis in `.papi/polkadot-api.json`;
  2. set the network's `genesis` in `networks.json` to the new value (the build fails while it differs
     from the `.papi` entry);
  3. delete the bootstrap state (`contracts/scripts/state/<network>.json`, or
     `contracts/deployments/<network>.json` on paseo-v2) and run the bootstrap, which redeploys the
     contracts and writes their new addresses into `networks.json`;
  4. fund the owner account again (`--only fund --fund <owner>`), update "Deployed contracts" above
     with the new addresses, commit, and rerun this workflow by hand: it re-registers the name and
     republishes.
- **Build and publish are separate jobs.** The build job holds no secret: it installs, generates the
  descriptors and builds, then uploads `dist/` as an artifact. The publish job, in the `<network>-deploy`
  environment, installs with `--ignore-scripts`, downloads that `dist/` and publishes it, so no build
  tooling runs where the mnemonic is.
- **Locked CLI.** The publish step handles the mnemonic, so `bulletin-deploy` is an exact-version
  devDependency of `apps/trade` (0.22.0), installed from the lockfile with integrity hashes and with no
  install scripts (`allowBuilds` in `pnpm-workspace.yaml`). `scripts/deploy-dot.mjs` runs that local
  copy with only the environment it needs, and the publish and bootstrap jobs do not restore a pnpm
  cache that other workflows write. Bump the version deliberately after reviewing a release.

## paseo-v2: one secret

On paseo-v2 every key lives in the `paseo-v2-deploy` secret `DOTNS_MNEMONIC`, and no copy exists
elsewhere. Its root account owns the dotNS name, funds the bootstrap and administers the test assets; the
bootstrap's EVM keys (the deployer, which administers the factory and owns the tUSD faucet, and four
trade-history keys) are its BIP-44 accounts. Both workflows sign with it, share one concurrency group,
and run only from `master`. Anything else that needs these keys, such as refilling the faucet, goes
through a workflow too.

First setup:

1. Generate a new mnemonic, for example with `subkey generate`. Store it as `DOTNS_MNEMONIC` and its
   SS58 address (the root sr25519 account, no derivation path) as `DOTNS_OWNER` in `paseo-v2-deploy`,
   then delete any local copy.
2. Fund `DOTNS_OWNER` from the faucet: about 425 PAS for the bootstrap, plus 5 PAS for the name deposit
   and fees.
3. Run the **Bootstrap network** workflow for `paseo-v2`. It takes about 20 minutes. Every run keeps its
   progress (`contracts/deployments/paseo-v2.json`) as a workflow artifact, even when it fails, and a
   rerun resumes from the newest progress kept by a bootstrap run on `master` since the deployment
   record last changed. It also pushes the progress and the addresses in `networks.json` to the branch
   `bootstrap/paseo-v2`, which the bootstrap itself never reads. When it succeeds, open a PR from that
   branch, add the new addresses to "Deployed contracts" in it, merge it, and delete the branch.
4. Run the **Deploy .dot app** workflow for `paseo-v2`.

After a reset, make one PR with steps 1 to 3 of "After a testnet reset" above (step 3 deletes
`contracts/deployments/paseo-v2.json`, so the next bootstrap ignores every earlier run's progress),
fund the owner from the faucet again, and run both workflows. A redeploy of new contracts on the same
chain works the same way, with the deployment record trimmed instead of deleted (see "Bootstrapping a
network" in the root README): removing `factory`, `markets`, `done` and `progress` keeps the accounts,
the test assets and the faucet, while deleting the record starts fresh.

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
- `.github/workflows/release.yml`: release on a `dot-v*` tag, to every network.
- `.github/workflows/deploy-dot.yml`: CI publish of one network.
- `.github/workflows/bootstrap.yml`: CI bootstrap, for networks whose keys live in their environment.

## Known caveat

Trade history and the candle chart read `eth_getLogs` from the network's eth-rpc, over HTTP. Inside a
host the app requests the `Remote` permission for that domain the first time it needs history; if the
user denies it, the chart only shows trades from the last few minutes, read through the chain client,
while trading still works. `src/hooks/use-trade-history.ts` explains why history comes from eth-rpc.
