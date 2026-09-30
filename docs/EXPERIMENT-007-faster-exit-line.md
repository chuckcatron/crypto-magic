# Experiment 007 — A faster exit line on BTC

**Status: PRE-REGISTERED.** This protocol was written and committed before any
variant below was run. The commit history is the evidence of that order.
Nothing in this section may be edited after results exist.

## Question

The regime filter sells only when a daily close falls below the 200-day
average. After a fast run the average lags far behind the price, so much of the
gain is given back before the exit. Does holding only while the close is also
above a **faster** average keep more of those gains, without losing more to
false exits than it saves, on the coin the bot trades?

## Variants

BTC-USD only; the bot is BTC-only (EXPERIMENT-006). The entry and exit rules
are:

| Variant                   | Holds while the daily close is above | Enters when above | Exits when below |
| ------------------------- | ------------------------------------ | ----------------- | ---------------- |
| **Baseline** (live today) | SMA200                               | SMA200            | SMA200           |
| **E100**                  | SMA200 **and** SMA100                | both              | either           |
| **E50**                   | SMA200 **and** SMA50                 | both              | either           |

Entry needs both lines too. Otherwise an exit on the fast line would be bought
straight back the next day while the close is still above SMA200.

50 and 100 days are the conventional faster averages. Neither is tuned: no other
period is tried. Everything else is as in EXPERIMENT-001: the 10-ATR intraday
disaster stop, fills at the next open, 60bps taker + 5bps slippage on every
fill, `--full-exposure`.

## Data and windows

| #   | Window                  | Data                                        | SHA-256 (first 16) |
| --- | ----------------------- | ------------------------------------------- | ------------------ |
| 1   | 2015-01-01 → 2022-01-01 | `data/btc-daily.csv` (Bitstamp, EXP-001)    | `5f766395d7e37f81` |
| 2   | 2022-01-01 → 2025-01-07 | `data/btc-daily.csv`                        | `5f766395d7e37f81` |
| 3   | 2025-01-07 → 2026-09-29 | `data/btc-cb-daily.csv` (Coinbase, EXP-003) | `bb1536d01867f18c` |

Before this protocol was written, the baseline was re-run on all three windows
with the new code and its defaults. It reproduced every published figure
(78.83% / −68.38%, 52.01% / −29.58%, −8.09% / −35.37%). No variant has been run.

**Not out of sample.** The baseline's results on all three windows are known,
and the question comes from knowing how it behaves after big runs. What is new
is only the variants' behavior, which nobody has computed. Two variants against
one baseline leaves room for luck, which is why the rule below requires a win on
every window.

## Decision rule

Each variant is compared with the baseline **at the same drawdown**, per window,
with `scripts/combine-sleeves.mjs --reference <baseline> --mix <variant>`:

- If the variant's maximum drawdown is shallower, the baseline is scaled down
  with idle cash to match it.
- Otherwise the variant must beat the full baseline outright.

A variant **passes** only if both of these hold:

1. **It beats the baseline at the same drawdown on all three windows**
   ("MIX BETTER", rounded to 0.01 points a year).
2. **It still passes EXPERIMENT-001's criterion on windows 1 and 2:** it beats
   the fixed BTC allocation with the same drawdown.

If both variants pass, the one with the higher mean margin across the three
windows is chosen. If neither passes, the exit stays as it is.

Reported for context, not part of the verdict:

- trades, fees and time in market;
- for each window's most profitable baseline trade, how far below its highest
  close the baseline exited, and the same for each variant over the same span
  ("give-back").

## What a pass would and would not mean

A pass supports a separate, reviewed change that lets the engine run the chosen
exit line in paper mode. It does not change the bot by itself.

It would not show that the variant beats buy-and-hold, and it says nothing about
coins other than BTC.

## Rules of conduct

1. Each of the 2 variants × 3 windows is run once, after this protocol is
   committed and pushed. The baseline is re-run once per window alongside
   them. No other period is tried.
2. Results are appended below this line, unedited.

---

## Results

_(appended after the runs)_

The protocol was committed as `a9cdd8a` and on GitHub at 20:23:14Z on
2026-09-29. The nine runs (3 windows × baseline, E100, E50) were each done
once, starting 20:23:21Z.

### The runs

| Window       | Variant  | Annualized | Max DD  | Trades | Time in market | EXP-001 criterion |
| ------------ | -------- | ---------- | ------- | ------ | -------------- | ----------------- |
| 1: 2015–2021 | Baseline | 78.83%     | −68.38% | 20     | 65%            | PASS by 8.43      |
|              | E100     | 83.71%     | −51.09% | 37     | 57%            | PASS by 39.33     |
|              | E50      | 84.73%     | −50.88% | 42     | 51%            | PASS by 40.61     |
| 2: 2022–2024 | Baseline | 52.01%     | −29.58% | 8      | 54%            | PASS by 38.28     |
|              | E100     | 32.66%     | −42.04% | 16     | 49%            | PASS by 13.12     |
|              | E50      | 41.64%     | −30.00% | 18     | 40%            | PASS by 27.72     |
| 3: 2025–2026 | Baseline | −8.09%     | −35.37% | 10     | 48%            | FAIL by 2.55      |
|              | E100     | 3.45%      | −24.28% | 12     | 37%            | PASS by 6.50      |
|              | E50      | 3.01%      | −20.72% | 11     | 32%            | PASS by 5.43      |

### The registered comparison (variant vs baseline at the same drawdown)

| Window | E100                     | E50                      |
| ------ | ------------------------ | ------------------------ |
| 1      | MIX BETTER, +73.52       | MIX BETTER, +74.67       |
| 2      | REFERENCE BETTER, −19.35 | REFERENCE BETTER, −10.37 |
| 3      | MIX BETTER, +8.80        | MIX BETTER, +7.52        |

In window 2 both variants' drawdowns were at least as deep as the baseline's,
so each was compared with the baseline at full size, and lost.

### Give-back on each window's best baseline trade (context)

| Window                | Peak close                      | Baseline exit        | E100 exit            | E50 exit             |
| --------------------- | ------------------------------- | -------------------- | -------------------- | -------------------- |
| 1 (2020-04 → 2021-05) | $63,564 (2021-04-13)            | $36,775, 42.1% below | $49,098, 22.8% below | $56,233, 11.5% below |
| 2 (2023-10 → 2024-07) | $73,121 (2024-03-13)            | $57,001, 22.0% below | $58,243, 20.3% below | $64,007, 12.5% below |
| 3                     | still open when the window ends | n/a                  | n/a                  | n/a                  |

## Verdict

**Neither variant passes. The exit stays as it is.**

Both variants lost window 2 (2022–2024). The rule requires a win on all three.

What the runs show, without changing the verdict:

- **The faster line did what it was meant to do at the top.** On the 2021 peak,
  E50 sold 11.5% below the highest close, against the baseline's 42.1%. It also
  cut the worst drawdown by 17 points in 2015–2021 and 15 points in 2025–2026,
  and turned 2025–2026 from a loss into a small gain.
- **It paid for that in 2022–2024.** In a steady recovery the faster line sold on
  ordinary pullbacks and bought back higher: twice as many trades, 40% time in
  market against 54%, and 10 to 19 points a year less than the baseline.
- **E50 is the closer call:** better on two windows by a wide margin, worse on
  one by 10 points with the same drawdown. That is a real trade-off between
  keeping gains at tops and staying in during recoveries, not a free
  improvement. Every one of these windows had been seen before, so a mixed
  result on known data is not enough to change the bot.

## Process notes

**The registered comparison overstated window 1.** `combine-sleeves.mjs`
scaled the baseline by setting a fixed fraction once and never rebalancing.
Over a window where the baseline grew 58×, that slice comes to dominate the
account and inherits almost all of its drawdown: "1.7% reference" showed a
−51% drawdown, which made the variants' margin look like +73 points.

The script was fixed after the runs to rebalance the fraction every bar (checked
by hand on a synthetic curve), and the comparison was re-run as an
after-the-fact check. **It is not the verdict, which stands as registered.**

| Window | E100                     | E50                      |
| ------ | ------------------------ | ------------------------ |
| 1      | MIX BETTER, +30.91       | MIX BETTER, +32.22       |
| 2      | REFERENCE BETTER, −19.35 | REFERENCE BETTER, −10.37 |
| 3      | MIX BETTER, +7.94        | MIX BETTER, +6.58        |

The wins and losses are the same, and in windows 1 and 3 the variants were
better on both return and drawdown outright, so no scaling method could flip
them. EXPERIMENT-006 only ever compared at 100%, where the two methods are
identical; its figures reproduce unchanged with the fixed script.

## Reproduce

```bash
cd apps/engine
common="--granularity ONE_DAY --strategy regime --sma-period 200 --full-exposure --product BTC-USD"
w1="--csv ../../data/btc-daily.csv --trade-from 2015-01-01 --to 2022-01-01"
npx tsx src/backtest/run-backtest.ts $common $w1 --json /tmp/w1-base.json
npx tsx src/backtest/run-backtest.ts $common $w1 --exit-sma-period 100 --json /tmp/w1-e100.json
npx tsx src/backtest/run-backtest.ts $common $w1 --exit-sma-period 50 --json /tmp/w1-e50.json
node ../../scripts/combine-sleeves.mjs --reference /tmp/w1-base.json --mix /tmp/w1-e50.json
# window 2: --csv ../../data/btc-daily.csv    --trade-from 2022-01-01 --to 2025-01-07
# window 3: --csv ../../data/btc-cb-daily.csv --trade-from 2025-01-07 --to 2026-09-29
```

The registered comparison used the script at `a9cdd8a`; later versions
rebalance the scaled reference (see Process notes).
