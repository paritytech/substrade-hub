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
   factory), or with `--contracts live` uses the network's factory, then creates two test assets, a
   market for them and 15 funded accounts;
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
`contracts/src/` or the benchmark, and can be run by hand after a runtime upgrade on paseo-v2. It
measures the PR's build
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
[KNOWN_ISSUES.md](../../KNOWN_ISSUES.md) still hold. After a runtime upgrade on paseo-v2, run the
Benchmark workflow by hand: it warns the same way, and the refreshed tables go in a pull request of
their own. `pnpm bench --from results.json
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
| `createMarket` |       0.38 |       4.52% |          0.33% |        1.0116 |           0.0335 |      |

### Limit order, resting

| Operation                                   | Proof (MB) | Proof limit | ref_time limit | Deposit (PAS) | Weight fee (PAS) | Note                       |
| ------------------------------------------- | ---------: | ----------: | -------------: | ------------: | ---------------: | -------------------------- |
| Rest a buy, empty book                      |       0.80 |       9.48% |          0.62% |        0.1858 |           0.0702 |                            |
| Post-only buy that would cross (rejected)   |       0.13 |       1.54% |          0.07% |             0 |           0.0114 | reverts PostOnlyWouldCross |
| Rest a buy, new level, 16 bid levels        |       1.03 |       12.3% |          0.74% |        0.1651 |           0.0911 |                            |
| Rest a buy, existing level, 16 bid levels   |       0.61 |       7.28% |          0.48% |        0.1032 |           0.0539 |                            |
| Rest a buy, new level, 64 bid levels        |       1.14 |      13.53% |          0.79% |        0.1651 |           0.1001 |                            |
| Rest a buy, new worst level, 64 bid levels  |       1.56 |      18.56% |          1.03% |        0.1651 |           0.1373 |                            |
| Rest a buy, new level, 256 bid levels       |       1.24 |      14.76% |          0.84% |        0.1651 |           0.1092 |                            |
| Rest a buy, new worst level, 256 bid levels |       1.72 |      20.52% |          1.12% |        0.1651 |           0.1518 |                            |

### Market order

| Operation                                       | Proof (MB) | Proof limit | ref_time limit | Deposit (PAS) | Weight fee (PAS) | Note                     |
| ----------------------------------------------- | ---------: | ----------: | -------------: | ------------: | ---------------: | ------------------------ |
| Market buy, empty book (fills nothing)          |       0.37 |       4.36% |          0.24% |        0.0619 |           0.0323 |                          |
| Market buy filling 1 level                      |       1.39 |      16.57% |          1.02% |      < 0.0001 |           0.1226 |                          |
| Market buy filling 6 levels                     |       5.47 |      65.22% |          4.26% |             0 |           0.4824 |                          |
| Market buy filling 7 levels (budget stops at 6) |       5.55 |       66.2% |           4.3% |             0 |           0.4897 |                          |
| All or nothing, 7 levels (rejected)             |       5.52 |      65.83% |          4.28% |             0 |           0.4870 | reverts SlippageExceeded |

### Limit order, taking

| Operation                                                       | Proof (MB) | Proof limit | ref_time limit | Deposit (PAS) | Weight fee (PAS) | Note |
| --------------------------------------------------------------- | ---------: | ----------: | -------------: | ------------: | ---------------: | ---- |
| Limit buy filling 1 level                                       |       1.40 |      16.67% |          1.12% |        0.0206 |           0.1233 |      |
| Limit buy filling 2 levels                                      |       2.17 |       25.9% |          1.84% |             0 |           0.1916 |      |
| Limit buy filling 3 levels                                      |       3.24 |       38.6% |          2.65% |             0 |           0.2856 |      |
| Limit buy filling 4 levels                                      |       4.00 |      47.62% |          3.27% |             0 |           0.3523 |      |
| Limit buy filling 5 levels                                      |       4.77 |      56.88% |           3.9% |             0 |           0.4208 |      |
| Limit buy filling 6 levels                                      |       5.45 |      64.92% |          4.48% |             0 |           0.4802 |      |
| Limit buy filling 7 levels (budget stops at 6)                  |       5.53 |       65.9% |          4.51% |             0 |           0.4875 |      |
| Limit buy filling 1 order at one level                          |       0.81 |       9.68% |          0.74% |        0.0826 |           0.0716 |      |
| Limit buy filling 6 orders at one level                         |       2.80 |      33.33% |          2.72% |        0.0826 |           0.2466 |      |
| Limit buy cancelling 6 own orders (budget stops)                |       5.74 |      68.39% |          4.19% |             0 |           0.5059 |      |
| Limit buy clearing 6 expired orders (budget stops)              |       2.23 |      26.59% |          2.06% |        0.0826 |           0.1968 |      |
| Limit sell clearing 6 expired cross-chain orders (budget stops) |       3.11 |      37.05% |          2.15% |        0.5779 |           0.2741 |      |

### Cancel and reduce

| Operation                                          | Proof (MB) | Proof limit | ref_time limit | Deposit (PAS) | Weight fee (PAS) | Note             |
| -------------------------------------------------- | ---------: | ----------: | -------------: | ------------: | ---------------: | ---------------- |
| Cancel the only order at its level (7 ask levels)  |       1.01 |      12.07% |          0.71% |             0 |           0.0893 |                  |
| Reduce an order                                    |       0.26 |       3.12% |          0.22% |             0 |           0.0231 |                  |
| Cancel the first of 14 orders at a level           |       0.44 |       5.21% |          0.34% |             0 |           0.0386 |                  |
| Cancel the 7th of 14 orders at a level             |       0.45 |       5.33% |          0.34% |             0 |           0.0395 |                  |
| Cancel the last of 14 orders at a level            |       0.44 |       5.21% |          0.34% |             0 |           0.0386 |                  |
| Cancel the only order at its level, 64 bid levels  |       1.38 |      16.49% |          0.91% |             0 |           0.1220 |                  |
| Cancel the only order at its level, 256 bid levels |       1.69 |      20.17% |          1.07% |             0 |           0.1492 |                  |
| Cancel an expired order                            |       0.44 |       5.21% |          0.34% |             0 |           0.0386 |                  |
| `batchCancelOrders`, 10 orders at one level        |       3.75 |      44.71% |          3.07% |             0 |           0.3307 |                  |
| `batchCancelOrders`, 20 orders at one level        |       7.43 |      88.59% |          6.11% |             0 |           0.6553 |                  |
| `batchCancelOrders`, 30 orders at one level        |      10.48 |     124.93% |           8.6% |             0 |           0.9241 | **does not fit** |
| `batchCancelOrders`, 40 orders at one level        |      10.48 |     124.93% |           8.6% |             0 |           0.9241 | **does not fit** |

### Cross-chain

| Operation                                                             | Proof (MB) | Proof limit | ref_time limit | Deposit (PAS) | Weight fee (PAS) | Note |
| --------------------------------------------------------------------- | ---------: | ----------: | -------------: | ------------: | ---------------: | ---- |
| Limit buy filling 1 level, taker cross-chain                          |       2.02 |      24.03% |           6.3% |        0.1032 |           0.1778 |      |
| Limit buy filling 4 levels, taker cross-chain                         |       6.22 |      74.17% |          23.8% |             0 |           0.5487 |      |
| Limit buy filling 5 levels, taker cross-chain (budget stops at 4)     |       6.30 |      75.15% |         23.84% |             0 |           0.5559 |      |
| Limit buy filling 1 level, both legs cross-chain                      |       2.55 |      30.43% |         11.41% |        0.0826 |           0.2251 |      |
| Limit buy filling 3 levels, both legs cross-chain                     |       6.19 |      73.77% |         33.19% |             0 |           0.5457 |      |
| Limit buy filling 4 levels, both legs cross-chain (budget stops at 3) |       6.27 |      74.76% |         33.23% |             0 |           0.5530 |      |
| Limit buy filling 1 level, maker cross-chain                          |       1.94 |      23.06% |          6.23% |        0.0206 |           0.1706 |      |
| Cancel a cross-chain order                                            |       1.15 |      13.69% |          0.72% |        0.0206 |           0.1013 |      |
| `claimSettlement`, refund claim                                       |       0.73 |       8.67% |          5.31% |             0 |           0.0642 |      |
| `redirectClaim`, refund claim                                         |       0.14 |       1.68% |          0.07% |             0 |           0.0125 |      |
| Limit buy cancelling 6 own cross-chain orders (budget stops)          |       5.93 |      70.63% |          3.89% |        0.2064 |           0.5225 |      |

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
  budget uses at most 68.4% of the limit with local fills, and 75.2% with cross-chain legs. The
  taker's own cross-chain orders, and expired cross-chain orders, are each refunded through a claim and
  charged like a local fill: six of the taker's own use 70.6%, and six expired ones 37.1%.
- **Every call that returns escrow fits.** Cancelling the only order at its level costs the most, and
  grows slowly with the book: 12% with 7 levels, 20% with 256.
- **Caller-sized batches have a ceiling.** `purgeExpired` costs about 3.5% of the limit per order it
  examines, and `batchCancelOrders` about 4.4% per order. Up to 25 and 20 orders fit; 30 do not. The
  app calls neither.
- **Cross-chain settlement goes through.** A factory starts with a cross-chain fee of 0, which
  disables cross-chain orders, so the benchmark sets 0.1 PAS, the fee the bootstrap sets. Each
  cross-chain leg then sends its XCM to para 1000 (Paseo Asset Hub), and the rows measure that
  settlement. Settling a refund claim, which cancelling a cross-chain order leaves, sends the escrow and
  the whole reserve plus the call's `msg.value` (one `minCrossChainFee` in the row), and costs 8.7%.
