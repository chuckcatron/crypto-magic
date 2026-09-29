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

The protocol was committed as `5d19d43` and on GitHub at 15:25:24Z on
2026-09-29, before anything below was done.

### What happened, in order

1. **The screen's first run returned 0 of 404 USD products.** This was a bug:
   the script tested `alias_to`, which lists the products aliased TO a product
   (LTC-USD lists LTC-USDC). The protocol's rule, "not an alias of another
   product", is the `alias` field, and no USD product has one. The one-line fix
   was committed and pushed as `dad1d01` before the screen was re-run. No
   candle had been fetched and nothing had been run.
2. **The screen, re-run once, selected 27 coins:** AAVE, ALGO, ATOM, BAL, BAND,
   BCH, BNT, CGLD, COMP, DASH, ETC, FIL, GRT, KNC, LINK, LTC, NMR, OXT, SNX, UMA,
   UNI, XLM, XRP, XTZ, YFI, ZEC, ZRX (all against USD).
3. **Each coin's history was fetched once** (15:28Z) and all 27 fetches
   succeeded. One disclosure: **XRP's history starts on 2023-07-13.** Coinbase
   halted XRP from January 2021 to July 2023, and the fetcher stops at the first
   empty stretch. A series spanning a 2½-year hole would feed a fictitious price
   jump into the 200-day average, so the continuous 2023–2026 series was used as
   fetched: 1,174 bars, enough to warm up. This decision did not depend on any
   result. No coin was excluded.
4. **81 runs** (27 coins × 3), once each, 15:29Z–15:31Z.

### Per coin

| Coin     | Traded from | A opt. annualized | A opt. max DD | A opt. stop exits | A pess. annualized | C annualized | C max DD | C stop exits | Buy & hold annualized | Data SHA-256 (16)  |
| -------- | ----------- | ----------------- | ------------- | ----------------- | ------------------ | ------------ | -------- | ------------ | --------------------- | ------------------ |
| AAVE-USD | 2021-07-04  | −17.56%           | −79.59%       | 0                 | −17.56%            | −17.56%      | −79.59%  | 0            | −10.23%               | `67aade15aa201b5a` |
| ALGO-USD | 2020-03-03  | −22.04%           | −90.78%       | 0                 | −22.04%            | −22.04%      | −90.78%  | 0            | −14.39%               | `8d492aee8027b902` |
| ATOM-USD | 2020-08-02  | −20.79%           | −96.38%       | 0                 | −20.79%            | −20.79%      | −96.38%  | 0            | −13.17%               | `642b2139e80b49a5` |
| BAL-USD  | 2021-04-25  | −39.89%           | −95.76%       | 1                 | −40.11%            | −36.00%      | −94.04%  | 0            | −66.05%               | `169f23f61ac3ea37` |
| BAND-USD | 2021-02-28  | −45.05%           | −98.15%       | 0                 | −45.05%            | −45.05%      | −98.15%  | 0            | −51.67%               | `3dd5d3acd8bee0eb` |
| BCH-USD  | 2018-07-09  | −13.68%           | −87.81%       | 0                 | −13.68%            | −13.68%      | −87.81%  | 0            | −10.32%               | `e07502e80ddc1f4b` |
| BNT-USD  | 2021-07-04  | −15.85%           | −69.61%       | 0                 | −15.85%            | −15.85%      | −69.61%  | 0            | −34.65%               | `8195eec90eab8573` |
| CGLD-USD | 2021-03-21  | −39.53%           | −96.98%       | 0                 | −39.53%            | −39.53%      | −96.98%  | 0            | −48.95%               | `9804cb9f9c1ddc34` |
| COMP-USD | 2021-01-10  | −24.02%           | −96.04%       | 0                 | −24.02%            | −24.02%      | −96.04%  | 0            | −30.20%               | `22a6dc9a5e186247` |
| DASH-USD | 2020-04-05  | −11.27%           | −93.27%       | 0                 | −11.27%            | −11.27%      | −93.27%  | 0            | −0.91%                | `5c8a040c79eadb90` |
| ETC-USD  | 2019-02-25  | −17.20%           | −91.78%       | 0                 | −17.20%            | −17.20%      | −91.78%  | 0            | 9.08%                 | `c4a75c90e10e68e7` |
| FIL-USD  | 2021-06-28  | −26.42%           | −85.20%       | 0                 | −26.42%            | −26.42%      | −85.20%  | 0            | −53.12%               | `86b2a9ac5d490b31` |
| GRT-USD  | 2021-07-06  | 2.09%             | −68.83%       | 0                 | 2.09%              | 2.09%        | −68.83%  | 0            | −45.64%               | `a37e0205cc825a2f` |
| KNC-USD  | 2020-09-13  | −47.34%           | −99.07%       | 0                 | −47.34%            | −47.34%      | −99.07%  | 0            | −31.27%               | `e18975617536d573` |
| LINK-USD | 2020-01-14  | 4.66%             | −95.79%       | 0                 | 4.66%              | 4.66%        | −95.79%  | 0            | 33.53%                | `886b6bb25301b514` |
| LTC-USD  | 2017-03-07  | 30.93%            | −92.61%       | 0                 | 30.93%             | 30.93%       | −92.61%  | 0            | 34.18%                | `cee295c439ea7976` |
| NMR-USD  | 2021-03-07  | −40.83%           | −98.51%       | 0                 | −40.83%            | −40.83%      | −98.51%  | 0            | −17.07%               | `f318a9e93931f30c` |
| OXT-USD  | 2020-07-04  | −43.80%           | −99.11%       | 0                 | −43.80%            | −43.80%      | −99.11%  | 0            | −35.52%               | `b3176b75f9c034da` |
| SNX-USD  | 2021-07-04  | −37.75%           | −91.65%       | 0                 | −37.75%            | −37.75%      | −91.65%  | 0            | −47.70%               | `a09386b9f83afb75` |
| UMA-USD  | 2021-03-28  | −39.88%           | −95.97%       | 0                 | −39.88%            | −39.88%      | −95.97%  | 0            | −51.56%               | `d8b1c5caf3364d8e` |
| UNI-USD  | 2021-04-06  | −51.40%           | −99.42%       | 0                 | −51.40%            | −51.40%      | −99.42%  | 0            | −20.65%               | `a9dff5718d7b15ae` |
| XLM-USD  | 2019-10-01  | 5.06%             | −84.93%       | 0                 | 5.06%              | 5.06%        | −84.93%  | 0            | 20.52%                | `3b13011003cce647` |
| XRP-USD  | 2024-01-30  | 29.28%            | −53.42%       | 0                 | 29.28%             | 29.28%       | −53.42%  | 0            | 46.41%                | `c9b09a82ad9d0aa0` |
| XTZ-USD  | 2020-02-23  | −44.64%           | −98.08%       | 1                 | −47.22%            | −46.84%      | −98.53%  | 1            | −30.18%               | `e947d32a2c62a88d` |
| YFI-USD  | 2021-04-04  | −37.38%           | −96.60%       | 0                 | −37.38%            | −37.38%      | −96.60%  | 0            | −39.14%               | `725f8c3942b43a61` |
| ZEC-USD  | 2021-06-27  | 4.93%             | −89.73%       | 0                 | 4.93%              | 4.93%        | −89.73%  | 0            | 65.44%                | `6e274d16e089c00c` |
| ZRX-USD  | 2019-05-01  | −36.64%           | −97.38%       | 0                 | −36.64%            | −36.64%      | −97.38%  | 0            | −10.57%               | `236d8e3241c3c14f` |

### Applying the decision rule

Today's stop fired on **2 of 27 coins**: BAL (once) and XTZ (once). On the other
25, all three variants are identical, as they must be.

| Coin    | C − A optimistic, annualized | C − A optimistic, max DD depth |
| ------- | ---------------------------- | ------------------------------ |
| BAL-USD | +3.89 pts                    | 1.72 pts shallower             |
| XTZ-USD | −2.20 pts                    | 0.45 pts deeper                |

The rule requires at least 6 informative coins. There are 2.

## Verdict

**INCONCLUSIVE. The stop stays as it is.**

Across EXPERIMENT-004 and 005, today's stop has fired in 3 of 33 coin-windows
(ETH 2017, BAL, XTZ). C was better in two and worse in one. That is too few
events to tell a better stop from luck, and more history on the same coins
cannot add many. At 10 ATR the disaster stop almost never fires; the 200-day
signal makes nearly every exit.

## An unplanned observation (not pre-registered)

The protocol said this experiment does not test whether the regime filter beats
holding these coins. The runs measure it anyway, and the result is too large to
leave out. Read it as exploratory: no rule was set for it in advance.

- **The regime filter lost money on 21 of 27 coins**, and its maximum drawdown
  was 53–99%, and deeper than 79% on 24 of them: about as deep as holding them.
- **It failed EXPERIMENT-001's criterion on 26 of 27 coins.** It lost to holding
  a fixed fraction of the coin with the same drawdown. It passed only on GRT.
- **It trailed buy-and-hold on 17 of 27.**

On these coins the filter did not do the one thing it did on BTC: keep the
account out of the long bear market. Coins that fall 90–99% while bouncing
above their 200-day average many times on the way down pull it back in again
and again. Most coins made 30–65 trades.

This does not overturn EXPERIMENT-001 on BTC, which passed two pre-registered
windows. It does say that **the filter's value is not a general property of
crypto trend-following.** It may be specific to BTC, or to a few coins, and ETH
and SOL, which the bot trades today, have more in common with these coins than
with BTC. Testing that properly would need its own pre-registered experiment.

## Reproduce

```bash
node scripts/screen-coinbase-products.mjs --listed-by 2020-12-31 --exclude BTC,ETH,SOL > coins.txt
mkdir -p data/exp5
for p in $(cat coins.txt); do
  node scripts/fetch-coinbase-history.mjs --product $p > data/exp5/$(echo $p | tr A-Z a-z).csv
done

cd apps/engine
common="--granularity ONE_DAY --strategy regime --sma-period 200 --full-exposure --to 2026-09-29"
for p in $(cat ../../coins.txt); do
  f=../../data/exp5/$(echo $p | tr A-Z a-z).csv
  npx tsx src/backtest/run-backtest.ts $common --csv $f --product $p                         # A optimistic
  npx tsx src/backtest/run-backtest.ts $common --csv $f --product $p --stop-fill low         # A pessimistic
  npx tsx src/backtest/run-backtest.ts $common --csv $f --product $p --stop-trigger close    # C
done
```

Coinbase revises recent candles and lists or delists products, so a later
screen or fetch may differ; the hashes above identify the data used.
