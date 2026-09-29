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
