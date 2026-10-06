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

The protocol was committed as `dcd57fa` and on GitHub at 21:14:15Z on
2026-10-06. `scripts/vol-target.mjs` and its tests followed as `0d5589a`
(21:21Z). The three variant runs were each done once, after both, at about
21:22Z. The script needed no fixes, so rule 2 was not triggered.

### Setup checks

- `data/btc-daily.csv` rebuilt from the Bitstamp archive: hash `5f766395d7e37f81`,
  as registered.
- `data/btc-cb-daily.csv` rebuilt from Coinbase's public endpoint. The fresh file
  runs to 2026-10-05 and hashed `7d9299023fe330d5`, as expected with extra days.
  Truncated to bars up to 2026-09-28 it hashes `bb1536d01867f18c`, as registered,
  and that truncated file was used. The untruncated one is kept as
  `data/btc-cb-daily-full.csv`.
- The baseline reproduced every published figure: 78.83% / −68.38%,
  52.01% / −29.58%, −8.09% / −35.37%.
- With the target set so high the weight is always 1, the script reproduced the
  baseline's final equity exactly on all three windows (58,574.25; 3,536.82;
  864.66). Seven unit tests cover sigma, the lack of lookahead, the band and the
  resize fee.

### The runs

| Window       | Variant  | Annualized | Max DD  | Avg weight | Time in market | Resizes | Resize fees |
| ------------ | -------- | ---------- | ------- | ---------- | -------------- | ------- | ----------- |
| 1: 2015–2021 | Baseline | 78.83%     | −68.38% | 1.00       | 65%            | 0       | 0           |
|              | V50      | 59.93%     | −56.65% | 0.76       | 66%            | 80      | 986.71      |
| 2: 2022–2024 | Baseline | 52.01%     | −29.58% | 1.00       | 54%            | 0       | 0           |
|              | V50      | 49.25%     | −26.93% | 0.95       | 54%            | 16      | 29.70       |
| 3: 2025–2026 | Baseline | −8.09%     | −35.37% | 1.00       | 48%            | 0       | 0           |
|              | V50      | −5.35%     | −31.70% | 0.98       | 49%            | 2       | 1.55        |

Resize fees are in the account's own dollars on a 1,000 start. In window 1 the
account grew 58 times over under the baseline, so 986.71 is small next to the
ending equity.

### The registered comparison (V50 vs baseline at the same drawdown)

| Window | Baseline scaled to match V50's drawdown | V50    | Verdict                 |
| ------ | --------------------------------------- | ------ | ----------------------- |
| 1      | 75.5% baseline, rest cash: 60.56%       | 59.93% | REFERENCE BETTER, −0.63 |
| 2      | 90.8% baseline, rest cash: 47.05%       | 49.25% | MIX BETTER, +2.20       |
| 3      | 87.9% baseline, rest cash: −6.77%       | −5.35% | MIX BETTER, +1.42       |

## Verdict

**V50 does not pass. The sizing stays as it is.**

It lost window 1 by 0.63 points a year at the same drawdown. The rule requires
a win on all three windows. Criterion 2 (EXPERIMENT-001's test on windows 1 and 2) was not evaluated, because criterion 1 had already failed.

What the runs show, without changing the verdict:

- **The gains are small and the one loss is small.** V50 was ahead by 2.20 and
  1.42 points on the two later windows and behind by 0.63 on the first. None of
  these is far from a tie, so the data does not show that volatility-based
  sizing beats a constant fraction, or that it loses to one.
- **Most of the saving was available without the volatility signal.** V50 cut
  the drawdown in every window, but a constant 75–91% baseline cut it by the
  same amount at nearly the same return.
- **The cost is mostly in the early window.** Window 1 had 80 resizes in a
  market that swung from very quiet to very wild, and the average weight was
  0.76. The later windows were calmer, the weight stayed near 1, and the variant
  barely differed from the baseline.
- **It did not fix 2025–2026.** The window turned from −8.09% to −5.35% a year,
  which is still a loss.

## Process notes

- The first attempt to re-run the baseline gave identical, wrong numbers for all
  three windows, because the shell did not split the flag variables and the
  backtest ran with defaults. Those outputs were discarded and the baseline was
  re-run under bash, which gave the published figures. No variant had been run.
- **Timing of the weights.** The protocol says σ uses closes "up to and
  including the day the decision is made". The script uses closes from bars that
  started before the interval's first curve point. For the entry interval that
  is exactly the signal bar. For later intervals it is one day staler than the
  strictest reading, which is the safe side. This was a reading of the protocol
  made while writing the script, before any variant run.

## Reproduce

```bash
cd apps/engine
common="--granularity ONE_DAY --strategy regime --sma-period 200 --full-exposure --product BTC-USD"
npx tsx src/backtest/run-backtest.ts $common --csv ../../data/btc-daily.csv \
  --trade-from 2015-01-01 --to 2022-01-01 --json /tmp/w1-base.json
cd ../..
node scripts/vol-target.mjs --baseline /tmp/w1-base.json --csv data/btc-daily.csv --out /tmp/w1-v50.json
node scripts/combine-sleeves.mjs --reference /tmp/w1-base.json --mix /tmp/w1-v50.json
# window 2: --csv data/btc-daily.csv --trade-from 2022-01-01 --to 2025-01-07
# window 3: --csv data/btc-cb-daily.csv (truncated to 2026-09-28) --trade-from 2025-01-07 --to 2026-09-29
```

Run the backtest commands under bash. In zsh `$common` is not split into
separate flags.
