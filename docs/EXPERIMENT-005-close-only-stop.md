# Experiment 005: a close-only disaster stop on coins not yet tested

**Status: PRE-REGISTERED.** This protocol was written and committed before any
coin was screened, any candle was fetched for it, or any backtest was run.
The commit history is the evidence of that order. Nothing in this section may
be edited after results exist.

## Question

In EXPERIMENT-004, variant C (the 10-ATR disaster stop judged on the daily
close instead of intraday) did no harm on any window and removed the ETH 2017
flash-crash loss. It could not pass, though. Today's stop fired in only one of
the six windows, and that window was the event that prompted the experiment.
EXPERIMENT-004's process notes said a fair test needs data no experiment here
has looked at, where today's stop actually fires.

On coins never used in any experiment here, does judging the disaster stop on
the daily close do better than judging it intraday?

## Strategy

The regime-sma200 filter on daily bars, unchanged: enter at the next open when
flat and the close is above the 200-day average, exit at the next open when it
closes below. Only the stop differs.

| Variant                         | Stop                                       | Checked                                                           |
| ------------------------------- | ------------------------------------------ | ----------------------------------------------------------------- |
| **A optimistic** (today's stop) | entry − 10 × ATR(14) at entry; never moves | intraday; fills at the stop price                                 |
| **A pessimistic**               | same                                       | intraday; fills at the bar's low                                  |
| **C: close-only**               | same level                                 | only when a daily close is at or below it; exits at the next open |

C is judged against **A optimistic**, the most flattering version of today's
stop. A pessimistic is reported for context and does not affect the verdict.

## Coin selection (applied after this commit, mechanically)

`scripts/screen-coinbase-products.mjs --listed-by 2020-12-31 --exclude BTC,ETH,SOL`
selects every Coinbase product that:

- is quoted in USD, online, not trading-disabled, and not an alias of another
  product;
- is not a stablecoin or a wrapped/staked copy of another asset (the script's
  `NOT_A_MARKET` list);
- is not BTC, ETH or SOL, the coins earlier experiments used;
- has a daily candle on or before 2020-12-31, which gives at least 5½ years of
  trading after the 200-day warmup.

The script only checks whether a candle exists. It never reads a price, so the
selection cannot depend on how a coin performed. Every coin it returns is
tested, and none is dropped afterwards for any reason except the one below.

A coin whose history cannot be fetched, or which has too few bars to warm the
indicator, is listed with the reason and excluded. That is the only permitted
exclusion.

**Known bias:** only coins still listed today can be selected. Delisted coins,
which often died in exactly the crashes a stop is for, are missing. Both
variants run on the same data, so the comparison is fair, but the absolute
returns flatter every variant.

## Data and window

- Full Coinbase daily history for each selected coin, fetched once with
  `scripts/fetch-coinbase-history.mjs` after this commit. Closed bars only.
  Each file's SHA-256 is recorded with the results.
- Trading starts at the first bar with a warmed 200-day average and ends at
  2026-09-29 (`--to 2026-09-29`). There is no development/holdout split: no
  parameter is chosen here, and every coin is out of sample for this question.
- Costs as before: 60bps taker + 5bps adverse slippage on every fill, both
  ways. `--full-exposure`.

## Decision rule

A coin is **informative** if A optimistic or C has at least one stop exit.
On any other coin the two are identical by construction: a close at or below
the stop implies a low at or below it, so C cannot fire where A did not.

- **Inconclusive** if fewer than 6 coins are informative. The stop stays as
  it is.
- Otherwise, **C passes** only if all four of these hold across the
  informative coins:
  1. C's annualized return is higher than A optimistic's on more than half of
     them;
  2. the median of (C − A optimistic) annualized return is above zero;
  3. the median of (C's max drawdown − A optimistic's), in depth, is zero or
     less, so C is not deeper at the median;
  4. on no coin is C's max drawdown more than 10 points deeper than A
     optimistic's. The guard is there because C's own risk is holding through
     a real crash that closes below the stop.
- Anything else: **C fails**, and the stop stays as it is.

A sign-test p-value for rule 1 is reported for context but is not part of the
rule.

## What a pass would and would not mean

A pass supports a separate, reviewed change to the engine that runs C in paper
mode. That change must also decide what protects a position while the engine is
not running. Today the live engine places an exchange-side stop, which triggers
intraday, exactly the behavior C removes.

A pass is not evidence that the regime filter beats holding these coins. This
experiment does not test that.

## Rules of conduct

1. The screen, the fetch and the 3 runs per coin are each done once, after this
   protocol is committed and pushed.
2. No other stop distance, trigger or cutoff date is tried.
3. Results are appended below this line, unedited.

---

## Results

_(appended after the runs)_
