# Experiment 003 — 200-day regime filter on ETH and SOL, and BTC since 2025

**Status: PRE-REGISTERED.** This protocol was written and committed before any
result below was computed. The commit history is the evidence of that order.
Nothing in this section may be edited after results exist.

## Question

EXPERIMENT-001 passed the regime filter on BTC only. The bot is being asked to
trade ETH-USD and SOL-USD with the same rule. Does the rule pass the same test on
those coins? And does it still hold on BTC over the period since EXPERIMENT-001's
data ended, which no experiment has looked at?

## Strategy (unchanged from EXPERIMENT-001, not tuned)

- Daily bars, UTC. Enter at the next open when the close is above SMA(200) and
  flat; exit at the next open when the close is below SMA(200).
- Disaster stop 10 ATR(14) below entry. No take-profit, trailing stop or maximum
  holding period. Confidence always 1.
- Run with `--full-exposure`: fully invested when in, flat when out, one coin at
  a time. It measures the timing rule per coin, not the three-coin portfolio.

## Data

Coinbase public daily candles (`scripts/fetch-coinbase-history.mjs`), closed
bars only, fetched 2026-09-29.

| Product | History from | Missing days |
| ------- | ------------ | ------------ |
| BTC-USD | 2015-07-20   | 0            |
| ETH-USD | 2016-05-18   | 2            |
| SOL-USD | 2021-06-17   | 0            |

Unlike the BTC series in EXPERIMENT-001 this data was not checked against price
landmarks or an independent source. It is the exchange the bot trades on.

## Windows

Earlier bars are used only to warm up the indicator.

| Product | Development             | Holdout                 |
| ------- | ----------------------- | ----------------------- |
| ETH-USD | 2017-01-01 → 2022-01-01 | 2022-01-01 → 2026-09-29 |
| SOL-USD | none (too little data)  | 2022-02-01 → 2026-09-29 |
| BTC-USD | covered by EXP-001      | 2025-01-07 → 2026-09-29 |

## Costs

60bps taker + 5bps adverse slippage on every fill, both ways (as EXPERIMENT-001).

## Success criterion (same as EXPERIMENT-001)

On each window, find the fixed allocation to that coin (rest in cash at 0%,
rebalanced monthly, paying the same fees) whose maximum drawdown equals the
strategy's. The strategy **passes** a window if its annualized return exceeds
that allocation's. If its drawdown exceeds 100% of the coin's, it must beat
buy-and-hold outright.

Verdicts:

- **ETH: PASS** only if it passes both development and holdout.
- **SOL: at most "holdout pass, insufficient history"**. One window cannot
  meet EXPERIMENT-001's two-window bar, and is reported as weaker evidence.
- **BTC: CONFIRMED** if it passes the new window, otherwise **NOT CONFIRMED**.
  Under two years, so it can weaken confidence in EXPERIMENT-001 but not
  overturn it.

## Rules of conduct

1. Each window is run once with the fixed strategy. No other SMA period, stop or
   cost is tried on these windows.
2. Results are appended below this line, unedited.
3. The bot's configuration is the owner's decision; this experiment informs it
   and does not change it.

---

## Results

_(appended after the runs)_

Each window was run once, on 2026-09-29, after the protocol above was committed
and pushed. Retail costs, fully invested when in, flat when out. The backtester
labels the benchmark "% BTC" whatever the product; below it is that coin.

### ETH-USD, development 2017-01-01 → 2022-01-01

|                | regime-sma200          | Same-drawdown allocation (100% ETH) | Buy & hold |
| -------------- | ---------------------- | ----------------------------------- | ---------- |
| Annualized     | 45.70%                 | 238.97%                             | 238.53%    |
| Max drawdown   | −99.18%                | −94.02%                             | −94.01%    |
| Sharpe         | 1.36                   | 1.66                                | 1.66       |
| Time in market | 67%                    | 100%                                | 100%       |
| Trades         | 18 (4 wins, 14 losses) | —                                   | —          |

**FAIL**. Its drawdown was deeper than holding ETH, and it trailed holding by
193 points a year.

Almost all of it is one bar. The position entered on 2017-02-03 at $10.83 and
held while ETH rose above $300. On 2017-06-22, the day of the Coinbase (then
GDAX) ETH flash crash when ETH briefly traded at $0.10, the daily low went
through the disaster stop, which is set 10 ATR below the ENTRY price and never
moves: $6.68. The backtest sold at $6.68 a coin that closed that day near $330,
giving back about 98% of peak equity. It re-entered at $327.52 the next day.
Noted, not adjusted: this is real exchange history, and the rule was run as
registered.

### ETH-USD, holdout 2022-01-01 → 2026-09-29

|                | regime-sma200          | Same-drawdown allocation (44.8% ETH) | Buy & hold |
| -------------- | ---------------------- | ------------------------------------ | ---------- |
| Annualized     | **14.72%**             | 2.89%                                | −6.65%     |
| Max drawdown   | −40.60%                | −40.59%                              | −74.05%    |
| Sharpe         | 0.54                   | 0.24                                 | 0.24       |
| Time in market | 43%                    | 100%                                 | 100%       |
| Trades         | 15 (4 wins, 11 losses) | —                                    | —          |

**PASS**, by 11.83 points a year.

### SOL-USD, holdout 2022-02-01 → 2026-09-29

|                | regime-sma200          | Same-drawdown allocation (44.2% SOL) | Buy & hold |
| -------------- | ---------------------- | ------------------------------------ | ---------- |
| Annualized     | **25.95%**             | 15.01%                               | 3.58%      |
| Max drawdown   | −62.86%                | −62.85%                              | −92.96%    |
| Sharpe         | 0.69                   | 0.52                                 | 0.49       |
| Time in market | 41%                    | 100%                                 | 100%       |
| Trades         | 21 (4 wins, 17 losses) | —                                    | —          |

**PASS**, by 10.94 points a year.

### BTC-USD, new window 2025-01-07 → 2026-09-29

|                | regime-sma200         | Same-drawdown allocation (59.7% BTC) | Buy & hold |
| -------------- | --------------------- | ------------------------------------ | ---------- |
| Annualized     | −8.09%                | **−5.54%**                           | −11.80%    |
| Max drawdown   | −35.37%               | −35.36%                              | −53.08%    |
| Sharpe         | −0.17                 | 0.00                                 | 0.02       |
| Time in market | 48%                   | 100%                                 | 100%       |
| Trades         | 10 (2 wins, 8 losses) | —                                    | —          |

**FAIL**, by 2.55 points a year. It lost less than holding BTC (−13.5% vs
−19.5% total) with a much smaller drawdown, but holding 59.7% BTC did better at
the same drawdown. Ten trades in under two years, eight of them losses: the
choppy market the filter is weakest in.

## Verdicts

| Product | Verdict                                                         |
| ------- | --------------------------------------------------------------- |
| ETH-USD | **FAIL** (development failed, holdout passed)                   |
| SOL-USD | **Holdout pass, insufficient history** (one window, 21 trades)  |
| BTC-USD | **NOT CONFIRMED** on 2025–2026; EXPERIMENT-001's pass is weaker |

What this does and does not say:

- The rule's clearest value on every coin since 2022 was drawdown: −41% vs −74%
  on ETH, −63% vs −93% on SOL, −35% vs −53% on BTC. Where it passed, it passed on
  return at matched drawdown too.
- ETH's failure is one flash crash against a stop that stays at the entry price.
  That is a property of the stop, and it applies to every coin the bot holds: a
  momentary crash below the stop sells the whole position, however far the
  price has risen since entry. A new experiment would be needed to test any
  change to it.
- None of these runs test the three-coin portfolio with a third of the money in
  each. Holding three correlated coins does not diversify much: all three fell
  hard in 2022.

## Process notes

- The ETH development window was run a second time with identical inputs and
  `--json`, to list its trades and find the cause of the −99% drawdown. Same
  numbers.

## Reproduce

```bash
for p in BTC ETH SOL; do
  node scripts/fetch-coinbase-history.mjs --product $p-USD > data/$(echo $p | tr A-Z a-z)-cb-daily.csv
done

cd apps/engine
common="--granularity ONE_DAY --strategy regime --sma-period 200 --full-exposure"
npx tsx src/backtest/run-backtest.ts $common --csv ../../data/eth-cb-daily.csv --product ETH-USD --trade-from 2017-01-01 --to 2022-01-01
npx tsx src/backtest/run-backtest.ts $common --csv ../../data/eth-cb-daily.csv --product ETH-USD --trade-from 2022-01-01 --to 2026-09-29
npx tsx src/backtest/run-backtest.ts $common --csv ../../data/sol-cb-daily.csv --product SOL-USD --trade-from 2022-02-01 --to 2026-09-29
npx tsx src/backtest/run-backtest.ts $common --csv ../../data/btc-cb-daily.csv --product BTC-USD --trade-from 2025-01-07 --to 2026-09-29
```

Coinbase can revise recent candles, so a later fetch may differ slightly.
