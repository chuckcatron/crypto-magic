# Experiment 010 — Volatility-targeted sizing on BTC

**Status: PRE-REGISTERED.** This protocol was written and committed before the
variant below was run. The commit history is the evidence of that order.
Nothing in this section may be edited after results exist.

## Question

The live strategy holds 99% of the account whenever BTC closes above its
200-day average, whatever the market is doing. Its worst losses come when
volatility is high: 2015–2021 drew down 68%, and 2025–2026 lost 8% a year with
a 35% drawdown. Does holding **less when recent volatility is high** earn more
than simply holding a smaller fixed share, at the same maximum drawdown?

EXPERIMENT-001 and 007 already set the yardstick: a strategy must beat the
baseline scaled down with idle cash to the same drawdown. A variant that only
shrinks the position gets no credit for shrinking it. It has to shrink it at
better moments than a constant fraction would.

## Variant

BTC-USD only (EXPERIMENT-006). Entries and exits are the baseline's, unchanged:
SMA200, 10-ATR disaster stop, fills at the next open. Only the **size** differs.

| Item                    | Baseline (live today)    | **V50**                                                                                           |
| ----------------------- | ------------------------ | ------------------------------------------------------------------------------------------------- |
| Weight when in market   | 1.00 (`--full-exposure`) | `w = min(1, 0.50 / σ)`                                                                            |
| σ                       | n/a                      | Standard deviation of the previous 30 daily log returns of the BTC close, times √365              |
| When the weight changes | never                    | At entry, and afterwards only when the new `w` differs from the held weight by **more than 0.10** |
| Leverage                | none                     | none: `w` never exceeds 1                                                                         |

- σ uses closes up to and including the day the decision is made. The new
  weight is traded at the next open, as the baseline's fills are.
- The rest of the account sits in cash earning 0%.
- 30 days, 50% and the 0.10 band are fixed here and **not tuned**. 50% sits
  below BTC's usual annualized volatility, so the weight is under 1 most of the
  time. The band exists because resizing every day at 65 bps would charge a few
  points a year in fees for small changes. No other target, window or band is
  tried.

Everything else is as in EXPERIMENT-001: 60 bps taker + 5 bps slippage on every
fill. Each resize pays 65 bps on the notional it trades. The baseline's own
entry and exit costs scale with the weight held.

## How it is computed

The variant is **not** a new engine run. A script (`scripts/vol-target.mjs`,
written after this protocol is pushed) takes the baseline's `--json` result and
the same CSV, and applies the weights above to the baseline's bar-by-bar
returns. The script is checked by unit test and by hand on a synthetic curve
before any run. The engine is not changed by this experiment.

A pass would therefore support building the sizing into the engine as a
separate, reviewed change, checked against this script. It would not change the
bot by itself.

## Data and windows

Same as EXPERIMENT-007:

| #   | Window                  | Data                                        | SHA-256 (first 16) |
| --- | ----------------------- | ------------------------------------------- | ------------------ |
| 1   | 2015-01-01 → 2022-01-01 | `data/btc-daily.csv` (Bitstamp, EXP-001)    | `5f766395d7e37f81` |
| 2   | 2022-01-01 → 2025-01-07 | `data/btc-daily.csv`                        | `5f766395d7e37f81` |
| 3   | 2025-01-07 → 2026-09-29 | `data/btc-cb-daily.csv` (Coinbase, EXP-003) | `bb1536d01867f18c` |

`data/` is gitignored, so both files are rebuilt first. If a rebuilt file's hash
differs from the one above, the run stops and the difference is reported. Before
the variant is run, the baseline is re-run on all three windows and must
reproduce the published figures (78.83% / −68.38%, 52.01% / −29.58%,
−8.09% / −35.37%).

**Not out of sample.** The baseline's results on all three windows are known,
and the idea comes from knowing where the baseline hurt. Only the variant's
behavior is new. One variant against one baseline limits the room for luck, and
the rule below requires a win on every window.

## Decision rule

The variant is compared with the baseline **at the same drawdown**, per window,
with `scripts/combine-sleeves.mjs --reference <baseline> --mix <variant>`,
using the version that rebalances the scaled reference every bar:

- If the variant's maximum drawdown is shallower, the baseline is scaled down
  with idle cash to match it.
- Otherwise the variant must beat the full baseline outright.

V50 **passes** only if both hold:

1. **It beats the baseline at the same drawdown on all three windows**
   ("MIX BETTER", rounded to 0.01 points a year).
2. **It still passes EXPERIMENT-001's criterion on windows 1 and 2:** it beats
   the fixed BTC allocation with the same drawdown.

If it does not pass, the sizing stays as it is.

Reported for context, not part of the verdict:

- average weight held, time in market, number of resizes and the fees they cost;
- annualized return and maximum drawdown of each window for both;
- the weight held in the weeks around each window's worst baseline drawdown.

## What a pass would and would not mean

It would show that sizing by recent volatility did better than a constant
fraction on three windows that had all been seen before. It would not show it
does so out of sample, it would not show that it beats buy-and-hold, and it
says nothing about coins other than BTC. The 2025–2026 window is the only one
the live bot has not yet traded.

## Rules of conduct

1. The variant is run once per window, after this protocol is committed and
   pushed. The baseline is re-run once per window alongside it. No other
   target, window, band or period is tried.
2. If the script has a bug, it is fixed, the fix is described, and every run is
   repeated once. The verdict is read from the repeated runs, and the first runs
   are kept in the results.
3. Results are appended below this line, unedited.

---

## Results

_(appended after the runs)_
