# Experiment 001 — 200-day regime filter

**Status: PRE-REGISTERED.** This protocol was written and committed before any
result below was computed. The commit history is the evidence of that order.
Nothing in this section may be edited after results exist.

## Hypothesis

ta-ensemble-v1 lost to buy-and-hold mainly by *not being in the market*: 8% time
in market on daily bars, and a 4-ATR take-profit that sold winners after roughly
a 16% gain, in an asset whose returns come from a few enormous rallies.

A regime filter — hold BTC while the daily close is above its 200-day simple
moving average, hold cash otherwise — stays in bull markets, steps aside in
sustained declines, and trades rarely enough that fees stop mattering.

## Strategy (fixed in advance, not tuned)

- Daily bars, UTC.
- **Enter** long at the next bar's open when the close is above SMA(200) and no
  position is held.
- **Exit** at the next bar's open when the close is below SMA(200).
- No take-profit. No trailing stop. No maximum holding period.
- A **disaster stop 10 ATR(14) below entry**, and nothing tighter. It exists to
  bound a crash between daily closes, not to manage the trade.
- Signal confidence is always 1.

N = 200 is chosen because it is the conventional value in the long-standing
moving-average timing literature, not because of anything in this data.

## Disclosure of prior knowledge

The author has already seen this entire price history while testing
ta-ensemble-v1, and knows that 2018 and 2022 were deep bear markets — exactly
the regime a 200-day filter is designed to sidestep. The *idea* was therefore
not chosen blind to the holdout period. The mitigation is that the rule has no
free parameters chosen here, and is a published, decades-old rule rather than
something fitted to this data. This caveat applies to every result below and
should weaken confidence in a pass more than in a fail.

## Data

Bitstamp BTC/USD, aggregated to daily UTC bars
(`scripts/fetch-btc-history.mjs`), validated in `docs/BACKTEST.md`.

| Period | Trading window | History used only for indicator warmup |
|---|---|---|
| **Development** | 2015-01-01 → 2022-01-01 | bars before 2015-01-01 |
| **Holdout** | 2022-01-01 → 2025-01-07 | bars before 2022-01-01 |

Using earlier bars to *compute* the indicator is not lookahead — that history
existed at the time. No decision in either window can see a bar after it.

## Costs

60bps taker + 5bps adverse slippage on every fill, both ways.

## Success criterion (primary)

On each period, find the fixed BTC allocation — rest in cash at 0% interest,
rebalanced monthly, paying the same fees on every rebalance — whose **maximum
drawdown equals the strategy's**. The strategy **passes** a period if its
annualized return exceeds that allocation's.

This is the benchmark that beat ta-ensemble-v1: it asks whether the strategy is
better than simply holding less Bitcoin at the same pain. If the strategy's
drawdown exceeds 100% BTC's, it must beat 100% buy-and-hold outright.

**Overall verdict: PASS only if it passes on BOTH development and holdout.**

## Rules of conduct

1. The strategy above is run unchanged on the development period.
2. As a robustness check on development ONLY, N ∈ {100, 150, 200, 250} is also
   run and **reported, not selected from**. The holdout uses N = 200 regardless
   of which value looks best on development.
3. The holdout is run **exactly once**, with the fixed strategy, after the
   development results are recorded.
4. No change to the strategy, costs, windows or criterion after the holdout has
   been seen. If it fails, it fails; a new idea is a new, separately
   pre-registered experiment.
5. Results are appended below this line, unedited.

---

## Results

*(appended after the runs)*

### Development period, 2015-01-01 → 2022-01-01 (recorded before the holdout was run)

Retail costs, fully invested when in, flat when out.

| | regime-sma200 | Same-drawdown allocation (66.6% BTC) | Buy & hold |
|---|---|---|---|
| Annualized | **78.83%** | 70.40% | 102.95% |
| Max drawdown | −68.38% | −68.37% | −83.43% |
| Sharpe | 1.26 | 1.31 | 1.32 |
| Time in market | 65% | 100% | 100% |
| Trades | 20 (4 wins, 16 losses) | — | — |

**Primary criterion: PASS** — beat the same-drawdown allocation by 8.43 points a
year.

Noted without adjusting anything:

- Its Sharpe (1.26) is *below* the matched allocation's (1.31). It passes the
  pre-registered test on return, not on every risk-adjusted measure.
- Maximum drawdown was still −68%: after the 2017 bubble the 200-day average
  lagged so far behind price that the exit came well off the peak.
- Win rate 20%, but the average winner was 8× the average loser — the usual
  trend-following profile. The disaster stop never fired; all 20 exits were
  regime signals.

#### Robustness sweep (development only — reported, not selected from)

| N | Annualized | Max drawdown | Sharpe | Trades | Same-DD allocation | Result |
|---|---|---|---|---|---|---|
| 100 | 83.66% | −68.18% | 1.32 | 44 | 66.3% BTC → 70.04% | PASS |
| 150 | 109.25% | −63.45% | 1.53 | 17 | 58.6% BTC → 62.02% | PASS |
| **200** | **78.83%** | **−68.38%** | **1.26** | **20** | **66.6% BTC → 70.40%** | **PASS** |
| 250 | 84.99% | −65.33% | 1.29 | 19 | 61.6% BTC → 65.11% | PASS |

All four pass, so the development result does not hinge on the exact period.
N = 150 looks best by a wide margin and N = 200 is the weakest of the four;
per rule 2 the holdout still uses N = 200. Choosing 150 now would be selecting
on the data this sweep was run on.

### Holdout period, 2022-01-01 → 2025-01-07 (run once, N = 200, nothing changed)

| | regime-sma200 | Same-drawdown allocation (35.6% BTC) | Buy & hold |
|---|---|---|---|
| Annualized | **52.01%** | 13.73% | 29.56% |
| Max drawdown | −29.58% | −29.57% | −67.00% |
| Sharpe | 1.33 | 0.75 | 0.74 |
| Time in market | 54% | 100% | 100% |
| Trades | 8 (4 wins, 4 losses) | — | — |

**Primary criterion: PASS** — beat the same-drawdown allocation by 38.28 points
a year. It also beat 100% buy-and-hold outright, which it did not do on the
development period.

The trades:

| Entry | Exit | Entry $ | Exit $ | P&L | Why out |
|---|---|---|---|---|---|
| 2023-01-14 | 2023-08-18 | 19,946 | 26,619 | +$319 (+32.1%) | signal |
| 2023-08-30 | 2023-08-31 | 27,736 | 27,288 | −$37 | signal |
| 2023-10-17 | 2024-07-05 | 28,534 | 57,001 | +$1,248 (+98.0%) | signal |
| 2024-07-14 | 2024-08-04 | 59,287 | 60,639 | +$27 | signal |
| 2024-08-24 | 2024-08-27 | 64,127 | 62,791 | −$83 | signal |
| 2024-09-25 | 2024-09-26 | 64,323 | 63,089 | −$76 | signal |
| 2024-09-27 | 2024-10-01 | 65,208 | 63,299 | −$98 | signal |
| 2024-10-15 | *open at end* | 66,103 | 102,229 | +$1,214 (+53.1%) | marked to market |

## Verdict

**PASS** under the pre-registered rule: it beat the same-drawdown fixed
allocation on both the development and the holdout period.

## How much to trust it

Less than the headline suggests, for four reasons that should travel with the
result:

1. **One event dominates the holdout.** The strategy held cash for all of 2022;
   its first entry was 2023-01-14. Buy-and-hold began the holdout at ~$46k and
   fell to ~$15.5k. Most of the outperformance against buy-and-hold is that
   single sidestep — and 2022 being a bear market is precisely the prior
   knowledge disclosed above.
2. **Two trades carry 98% of the holdout profit**, and one of them was still open
   when the data ended, so roughly half the gain is marked to market at the
   final price rather than realized.
3. **The sample is small.** 28 trades across ten years, and the thing that
   actually matters for a regime filter — distinct bear markets — numbers about
   three. That is very few independent observations.
4. **It is not uniformly better.** On development it trailed buy-and-hold by
   24 points a year and had a slightly lower Sharpe than its matched allocation.
   Its edge is avoiding deep bear markets; in an unbroken bull run it lags.

What the result does establish: this is not ta-ensemble-v1's failure mode. It
stays in the market through bull runs (54–65% of the time), trades rarely enough
that costs are negligible, and the development pass held at every N tested.
It earns the right to be paper traded. It has not earned real money.

## Process notes

- The holdout command was executed three times with identical inputs: the
  scored run, a re-run after a header-text fix (the window description wrongly
  counted indicator-history bars as traded bars), and a run with `--json` to
  list the trades. All three produced the same numbers; nothing about the
  strategy, data, costs or window changed between them.
- The equal-drawdown benchmark was checked first against yesterday's
  independent calculation for ta-ensemble-v1 (19.8% BTC at 17.77%/yr vs
  20% at 18.4%), before any experiment result existed.

## Reproduce

```bash
node scripts/fetch-btc-history.mjs --granularity ONE_DAY > data/btc-daily.csv

# development
pnpm backtest -- --csv data/btc-daily.csv --granularity ONE_DAY --strategy regime \
  --sma-period 200 --trade-from 2015-01-01 --to 2022-01-01 --full-exposure

# holdout
pnpm backtest -- --csv data/btc-daily.csv --granularity ONE_DAY --strategy regime \
  --sma-period 200 --trade-from 2022-01-01 --to 2025-01-07 --full-exposure
```
