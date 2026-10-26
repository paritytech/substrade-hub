# Benchmarks

What each DLOB operation costs on Asset Hub, measured on the real runtime, against what one
transaction may use. Use it to check that an operation fits in every book state, and to estimate fees.

## Limits

One normal transaction on Paseo Asset Hub Next (`next-asset-hub-paseo` 3004000, the runtime both demo
networks run) may use:

| Resource   | Limit                     |
| ---------- | ------------------------- |
| Proof size | 8,388,608 bytes (8 MiB)   |
| ref_time   | 1,599,875,000,000 (1.6 s) |

Proof size is the limit every operation meets first: ref_time stays under 10% of its limit for every
local operation, and under 35% with cross-chain legs.

## How it is measured

`scripts/bench/bench.mjs` runs against a [Chopsticks](https://github.com/AcalaNetwork/chopsticks) fork
of the network, which runs the live runtime on a copy of the live state. On the fork it:

1. deploys the contracts in `contracts/out/` (the two libraries, the `DLOB` implementation and the
   factory), then creates two test assets, a market for them and 15 funded accounts;
2. builds each book state with real transactions;
3. dry-runs the measured call against that state with `ReviveApi.call`, and reads the weight it
   requires, its storage deposit and the fee for that weight.

Nothing reaches the live chain. Between scenarios the fork is rewound to an earlier block.

```bash
cd contracts
pnpm bench:fork                                # terminal 1: fork paseo-v2 (NETWORK=previewnet for previewnet)
pnpm bench                                     # terminal 2: every scenario, about 25 minutes
pnpm bench --sections ladder,cross-chain       # some of them
pnpm bench --out results.json                  # also write the results as JSON
pnpm bench --contracts live                    # the network's deployed factory, as its admin
pnpm bench --network previewnet --contracts live
pnpm bench --check 95 --summary summary.md     # fail over 95% of a limit; write a Markdown table
```

Run `forge build` first: by default (`--contracts build`), the benchmark measures the build in
`contracts/out/`. `--contracts live` uses the network's factory, acting as its admin with the fork's
mock signatures, to measure what is deployed. The sections are `empty`, `ladder`, `level`, `self`,
`tree`, `cross-chain` and `expired`; `--levels` sets the book sizes of `tree` (default `64,256`).

The fork reads live state from the network's public RPC node as it needs it, and caches it in
`.chopsticks/`. When that node drops the connection, the fork stops building blocks and the run waits:
restart both, and the next run reuses the cache.

A dry run may use up to the block's 10 MiB of proof (125% of one transaction's), so a call too large
for one transaction can still succeed in it; one larger than the block runs out of gas there. The
tables mark both as **does not fit**, and a row at 124.93% (10.48 MB) is that cap: `batchCancelOrders`
with 30 orders and with 40 both stop there, which is no measure of what either would cost.

## In CI

The Benchmark workflow (`.github/workflows/bench.yml`) runs on pull requests that touch
`contracts/src/` or the benchmark, and weekly to catch a runtime upgrade. It measures the PR's build
with every section, the `tree` one at 64 levels, and fails when a call uses more than 95% of the proof
or ref_time limit. The rows sized past the documented ceilings (`purgeExpired` above 25 orders,
`batchCancelOrders` above 20) are left out of that check. It also warns about each row that moved
more than 5% from the tables below. The table and the warnings are in the run's summary. CI runs the
`tree` section at 64 levels only, so the 256-level rows are not compared: refresh the tables by hand
after a change that could move them, such as one to the red-black tree.

## Keeping the results up to date

The tables below are written by the benchmark itself, between the `bench:results` markers: do not edit
them by hand. Refresh them in the same pull request whenever the Benchmark workflow warns that they are
out of date, which happens when a contract change moves a row by more than 5% of its value (rows under
1% of a limit are not compared), adds an operation or renames one:

```bash
cd contracts
forge build
pnpm bench:fork                   # terminal 1
pnpm bench --write-docs           # terminal 2: every section at the default levels
npx prettier@3.3.3 --write docs/benchmarks.md
```

Then check that "What the numbers say", the batch sizes in [how it works](how-it-works.md) and
[KNOWN_ISSUES.md](../../KNOWN_ISSUES.md) still hold. The weekly run warns the same way after a runtime
upgrade on paseo-v2; refresh the tables in a pull request of their own. `pnpm bench --from results.json
--write-docs` writes them from a run saved with `--out`, without a fork.

## Results

Proof in MB (10^6 bytes) and as a share of the limit above. The deposit is the storage deposit charged;
a call that frees storage is refunded, shown as 0. The weight fee is the fee for the call's weight
only, without the length fee.

The book holds 1-unit orders from distinct makers, one per price level unless the operation says
otherwise. "Levels" are price levels on the side the order takes from.

<!-- bench:results:start -->

### Factory

| Operation      | Proof (MB) | Proof limit | ref_time limit | Deposit (PAS) | Weight fee (PAS) | Note |
| -------------- | ---------: | ----------: | -------------: | ------------: | ---------------: | ---- |
| `createMarket` |       0.37 |        4.4% |          0.32% |        0.5693 |           0.0326 |      |

### Limit order, resting

| Operation                                   | Proof (MB) | Proof limit | ref_time limit | Deposit (PAS) | Weight fee (PAS) | Note                       |
| ------------------------------------------- | ---------: | ----------: | -------------: | ------------: | ---------------: | -------------------------- |
| Rest a buy, empty book                      |       0.80 |       9.48% |          0.62% |        0.1858 |           0.0701 |                            |
| Post-only buy that would cross (rejected)   |       0.11 |       1.29% |          0.06% |             0 |           0.0096 | reverts PostOnlyWouldCross |
| Rest a buy, new level, 16 bid levels        |       1.03 |       12.3% |          0.74% |        0.1651 |           0.0910 |                            |
| Rest a buy, existing level, 16 bid levels   |       0.60 |       7.15% |          0.48% |        0.1032 |           0.0530 |                            |
| Rest a buy, new level, 64 bid levels        |       1.14 |      13.53% |          0.79% |        0.1651 |           0.1001 |                            |
| Rest a buy, new worst level, 64 bid levels  |       1.56 |      18.56% |          1.03% |        0.1651 |           0.1373 |                            |
| Rest a buy, new level, 256 bid levels       |       1.24 |      14.75% |          0.84% |        0.1651 |           0.1092 |                            |
| Rest a buy, new worst level, 256 bid levels |       1.72 |      20.52% |          1.12% |        0.1651 |           0.1518 |                            |

### Market order

| Operation                                       | Proof (MB) | Proof limit | ref_time limit | Deposit (PAS) | Weight fee (PAS) | Note                     |
| ----------------------------------------------- | ---------: | ----------: | -------------: | ------------: | ---------------: | ------------------------ |
| Market buy, empty book (fills nothing)          |       0.36 |       4.24% |          0.24% |        0.0619 |           0.0314 |                          |
| Market buy filling 1 level                      |       1.38 |      16.44% |          1.02% |      < 0.0001 |           0.1217 |                          |
| Market buy filling 6 levels                     |       5.46 |      65.09% |          4.26% |             0 |           0.4815 |                          |
| Market buy filling 7 levels (budget stops at 6) |       5.54 |      66.07% |           4.3% |             0 |           0.4888 |                          |
| All or nothing, 7 levels (rejected)             |       5.51 |       65.7% |          4.28% |             0 |           0.4860 | reverts SlippageExceeded |

### Limit order, taking

| Operation                                          | Proof (MB) | Proof limit | ref_time limit | Deposit (PAS) | Weight fee (PAS) | Note |
| -------------------------------------------------- | ---------: | ----------: | -------------: | ------------: | ---------------: | ---- |
| Limit buy filling 1 level                          |       1.39 |      16.54% |          1.11% |        0.0206 |           0.1224 |      |
| Limit buy filling 2 levels                         |       2.16 |      25.78% |          1.84% |             0 |           0.1907 |      |
| Limit buy filling 3 levels                         |       3.23 |      38.47% |          2.65% |             0 |           0.2846 |      |
| Limit buy filling 4 levels                         |       3.98 |      47.49% |          3.27% |             0 |           0.3513 |      |
| Limit buy filling 5 levels                         |       4.76 |      56.76% |           3.9% |             0 |           0.4198 |      |
| Limit buy filling 6 levels                         |       5.44 |      64.79% |          4.47% |             0 |           0.4793 |      |
| Limit buy filling 7 levels (budget stops at 6)     |       5.52 |      65.77% |          4.51% |             0 |           0.4865 |      |
| Limit buy filling 1 order at one level             |       0.80 |       9.55% |          0.74% |        0.0826 |           0.0707 |      |
| Limit buy filling 6 orders at one level            |       2.79 |       33.2% |          2.71% |        0.0826 |           0.2456 |      |
| Limit buy cancelling 6 own orders (budget stops)   |       5.73 |      68.27% |          4.18% |             0 |           0.5050 |      |
| Limit buy clearing 6 expired orders (budget stops) |       2.22 |      26.47% |          2.05% |        0.0826 |           0.1958 |      |

### Cancel and reduce

| Operation                                          | Proof (MB) | Proof limit | ref_time limit | Deposit (PAS) | Weight fee (PAS) | Note             |
| -------------------------------------------------- | ---------: | ----------: | -------------: | ------------: | ---------------: | ---------------- |
| Cancel the only order at its level (7 ask levels)  |       1.01 |      12.07% |          0.71% |             0 |           0.0893 |                  |
| Reduce an order                                    |       0.26 |       3.12% |          0.22% |             0 |           0.0231 |                  |
| Cancel the first of 14 orders at a level           |       0.44 |       5.21% |          0.34% |             0 |           0.0386 |                  |
| Cancel the 7th of 14 orders at a level             |       0.45 |       5.33% |          0.34% |             0 |           0.0395 |                  |
| Cancel the last of 14 orders at a level            |       0.44 |       5.21% |          0.34% |             0 |           0.0386 |                  |
| Cancel the only order at its level, 64 bid levels  |       1.39 |      16.61% |          0.91% |             0 |           0.1229 |                  |
| Cancel the only order at its level, 256 bid levels |       1.70 |      20.29% |          1.08% |             0 |           0.1501 |                  |
| Cancel an expired order                            |       0.44 |       5.21% |          0.34% |             0 |           0.0386 |                  |
| `batchCancelOrders`, 10 orders at one level        |       3.75 |      44.71% |          3.07% |             0 |           0.3307 |                  |
| `batchCancelOrders`, 20 orders at one level        |       7.43 |      88.59% |          6.11% |             0 |           0.6553 |                  |
| `batchCancelOrders`, 30 orders at one level        |      10.48 |     124.93% |           8.6% |             0 |           0.9241 | **does not fit** |
| `batchCancelOrders`, 40 orders at one level        |      10.48 |     124.93% |           8.6% |             0 |           0.9241 | **does not fit** |

### Cross-chain

| Operation                                                             | Proof (MB) | Proof limit | ref_time limit | Deposit (PAS) | Weight fee (PAS) | Note           |
| --------------------------------------------------------------------- | ---------: | ----------: | -------------: | ------------: | ---------------: | -------------- |
| Limit buy filling 1 level, taker cross-chain                          |       2.00 |      23.78% |           6.3% |        0.1032 |           0.1759 |                |
| Limit buy filling 4 levels, taker cross-chain                         |       6.20 |      73.91% |         23.79% |             0 |           0.5467 |                |
| Limit buy filling 5 levels, taker cross-chain (budget stops at 4)     |       6.28 |      74.89% |         23.83% |             0 |           0.5540 |                |
| Limit buy filling 1 level, both legs cross-chain                      |       2.53 |      30.17% |         11.41% |        0.0826 |           0.2232 |                |
| Limit buy filling 3 levels, both legs cross-chain                     |       6.17 |      73.51% |         33.18% |             0 |           0.5437 |                |
| Limit buy filling 4 levels, both legs cross-chain (budget stops at 3) |       6.25 |      74.49% |         33.22% |             0 |           0.5510 |                |
| Limit buy filling 1 level, maker cross-chain                          |       1.92 |      22.93% |          6.22% |        0.0206 |           0.1697 |                |
| Cancel a cross-chain order                                            |       1.15 |      13.69% |          0.72% |        0.0206 |           0.1013 |                |
| `claimSettlement`, refund claim                                       |       0.62 |       7.44% |          5.23% |             0 |           0.0551 | reverts (#144) |
| `redirectClaim`, refund claim                                         |       0.14 |       1.68% |          0.07% |             0 |           0.0124 |                |

### Purge expired

| Operation                 | Proof (MB) | Proof limit | ref_time limit | Deposit (PAS) | Weight fee (PAS) | Note             |
| ------------------------- | ---------: | ----------: | -------------: | ------------: | ---------------: | ---------------- |
| `purgeExpired`, 5 orders  |       1.58 |      18.84% |          1.38% |             0 |           0.1394 |                  |
| `purgeExpired`, 10 orders |       3.06 |      36.49% |          2.71% |             0 |           0.2699 |                  |
| `purgeExpired`, 20 orders |       6.02 |      71.79% |          5.38% |             0 |           0.5310 |                  |
| `purgeExpired`, 25 orders |       7.50 |      89.44% |          6.71% |             0 |           0.6616 |                  |
| `purgeExpired`, 30 orders |       8.98 |     107.09% |          8.04% |             0 |           0.7921 | **does not fit** |

<!-- bench:results:end -->

## What the numbers say

- **The matching budget fits.** A local fill costs 0.7 to 1.1 MB of proof, about 0.8 MB on average,
  and a cross-chain leg about 0.55 MB more, in line with the estimates behind `MATCH_BUDGET`. A full
  budget uses at most 68% of the limit with local fills, and 75% with cross-chain legs. The taker's own
  cross-chain orders, and expired cross-chain orders, are each refunded through a claim and charged
  like a local fill. A full budget of six of each is measured by the `cross-chain` and `expired`
  sections; the next full run adds their rows, and the fill claim's, to the tables.
- **Every call that returns escrow fits.** Cancelling the only order at its level costs the most, and
  grows slowly with the book: 12% with 7 levels, 20% with 256.
- **Caller-sized batches have a ceiling.** `purgeExpired` costs about 3.5% of the limit per order it
  examines, and `batchCancelOrders` about 4.4% per order. Up to 25 and 20 orders fit; 30 do not. The
  app calls neither.
- **Cross-chain rows measure the fallback path.** On paseo-v2, the settlement XCM fails inside the
  market, so every cross-chain fill creates a pending claim, and `claimSettlement` reverts (#144). The
  fill rows include that failed attempt and the claim creation. `claimSettlement` is measured on both
  kinds of claim: a fill claim, which sends one `minCrossChainFee` from the order's reserve, and a
  refund claim, left by cancelling a cross-chain order, which sends the whole reserve. The
  fork sets a cross-chain fee of 0.1 PAS, since the networks' fee of 0 makes every cross-chain fill
  revert (#143), and funds para 1000's sovereign account. A successful settlement should cost about
  the same: executing the same message from an account costs about 0.41 MB of proof.
