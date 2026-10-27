# Contributing to SubsTrade Hub

Contributions are welcome through issues, pull requests, reviews and testing feedback. How the order
book works is documented in [how it works](contracts/docs/how-it-works.md); this file covers the
mechanics of contributing.

## Reporting a vulnerability

Do not open a public issue for a vulnerability. Follow [SECURITY.md](SECURITY.md). Limitations that
are already known and accepted are listed in [KNOWN_ISSUES.md](KNOWN_ISSUES.md).

## Opening an issue

Check the open issues first, and add details to an existing one when it covers the same problem.
Include:

- a short, specific title;
- the expected and the actual behaviour;
- a minimal reproduction where possible, such as a failing test;
- the network (previewnet, paseo-v2 or local), and the wallet when the app is involved.

For a change to contract behaviour or the ABI, describe the problem it solves, what it changes for
integrators and the app, and any security implications.

## Opening a pull request

- Open it against `master`, and link the issue it fixes with `Fixes #N`.
- Keep it to one concern; split unrelated changes into separate pull requests.
- Update the docs and [KNOWN_ISSUES.md](KNOWN_ISSUES.md) in the same pull request as the behaviour
  they describe.
- Add or update tests for the behaviour you change.

Pull requests are squash-merged after one approving review and passing checks. Workflows on a pull
request from an outside contributor run once a maintainer approves them.

## Checks to run

CI runs the following. Run the ones for the parts you changed before pushing.

**Contracts** (inside `contracts/`), with [Foundry for Polkadot](https://github.com/paritytech/foundry-polkadot)
v1.5.1, the version CI installs. `forge fmt` output differs between versions.

```bash
forge fmt --check
forge build --sizes
forge test --polkadot --no-match-test "invariant_"
FOUNDRY_PROFILE=ci forge test --polkadot --match-test "invariant_"
```

pallet-revive limits a contract to 24 KiB, and CI fails a build that leaves a deployed contract within
512 bytes of that limit. `DLOB` is close to it. Measure sizes after `rm -rf out cache`, since an
incremental build can report a wrong size.

The Benchmark workflow measures every contract operation on a fork of paseo-v2 and fails a pull request
that makes one use more than 95% of a transaction's limits. When it warns that the results in
[benchmarks](contracts/docs/benchmarks.md) are out of date, refresh them in the same pull request, as
that page describes.

**App** (from the repository root):

```bash
pnpm install
pnpm --filter @substrade-hub/trade exec papi generate
pnpm --filter @substrade-hub/trade lint
pnpm --filter @substrade-hub/trade typecheck
pnpm --filter @substrade-hub/trade test
VITE_NETWORK=previewnet pnpm --filter @substrade-hub/trade build
```

After an ABI change, run `pnpm sync-abi` inside `apps/trade/` (after `forge build`) and commit the
regenerated files under `apps/trade/src/abi/`.

**E2E** (inside `e2e/`): CI checks formatting only, with `cargo fmt --all --check`. The suite itself,
`cargo test -- --nocapture`, compiles the polkadot-sdk runtimes, which takes too long for CI, so run it
locally in a pull request that changes `contracts/src/` or `e2e/`. It needs `forge build` in
`contracts/` first, and its first build is slow (over an hour); later runs take minutes. See the
[e2e README](e2e/README.md).

**Docs:** CI checks the links in the root Markdown files, `contracts/docs/` and the Solidity sources
under `contracts/` with [Lychee](https://github.com/lycheeverse/lychee).

## Standards

- **Licence headers.** New source files start with the same two lines as the existing ones:

  ```
  // SPDX-License-Identifier: MIT
  // SPDX-FileCopyrightText: © 2026 Parity Technologies
  ```

- **Formatting.** Format only the code you change, with `forge fmt` for Solidity and `cargo fmt` for
  Rust, and follow the existing style in TypeScript.
- **Comments** explain behaviour. The history of a change goes in the pull request description.
- **Tests** are deterministic and named after the behaviour they check. Fuzz and invariant tests cover
  properties over random inputs; see [testing](contracts/docs/testing.md).
- **App errors.** The app shows a user only messages they can act on, or a clear contract error, and
  sends raw error text to the console.

## Code of conduct

Be respectful and constructive. Harassment, abuse and aggressive behaviour are not acceptable. Spam,
and contributions unrelated to SubsTrade Hub, may be closed.
