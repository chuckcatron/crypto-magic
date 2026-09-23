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
