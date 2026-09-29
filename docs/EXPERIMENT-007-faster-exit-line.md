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
