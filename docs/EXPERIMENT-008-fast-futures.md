# Experiment 008 — Fast trading on Coinbase US perpetual futures

**Status: PRE-REGISTERED.** This protocol was written and committed before any
rule below was run on any data. The commit history is the evidence of that
order. Nothing in this section may be edited after results exist.

## Question

The owner wants a fast bot that trades any liquid crypto in both directions.
Spot cannot support that. Under this repo's spot cost model (60 bps fee plus
5 bps slippage per side, 1.3% a round trip), even perfect hindsight inside a
15-minute BTC bar covered the round trip on 0.6% of bars over the last 60 days
(measured 2026-10-06). Coinbase's US perpetual-style futures cost roughly a
tenth as much per fill and allow shorting.

**At futures costs, and under hard risk rules, does any of four pre-specified
fast strategies make money after costs out of sample?**

## Instruments, and the price used to test them

Coinbase Derivatives perpetual-style futures, traded through Coinbase Financial
Markets. Contract sizes on 2026-10-06: BTC 0.01, ETH 0.1, SOL 5.

They began trading on 2025-07-21, too late for a multi-year test. Every rule
below is therefore run on the coin's **Coinbase USD spot price** as a proxy for
its perpetual, and charged futures costs. Funding keeps a perpetual close to
spot. Where the public API serves perpetual candles, the gap between the two is
measured on the overlap and reported. It is not used in scoring.

## Costs (fixed in advance)

| Item                                                     | Base                               | Stress (criterion 4) |
| -------------------------------------------------------- | ---------------------------------- | -------------------- |
| Every fill, entry or exit, all-in: fee, spread, slippage | 8 bps of notional                  | 16 bps               |
| Funding, on every open position, long or short           | 0.15 bps per hour held (≈13% a yr) | same                 |

Where the base comes from:

- An advertised promotional taker fee of 0.03%.
- An exchange fee of $0.10 per contract, as reported for the BTC contract and
  assumed for the others: about 1.2 bps on BTC and 3.7 bps on ETH at today's
  prices.
- Half of the live spread on each fill: spreads were 1.2 bps on BTC, 3.7 on ETH
  and 2.5 on SOL.
- Slippage.

Coinbase's fee pages could not be opened from the research environment, which
is why criterion 4 doubles the cost. Real funding is sometimes received rather
than paid, so charging both sides is the conservative choice.

Contract sizes are ignored, so positions can be fractional. This measures the
edge, not the smallest account that could trade it.

## Risk rules

These are part of the system under test, not tuning knobs.

| Rule                   | Setting                                                                                                           |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Capital                | Split equally across the coins a strategy trades. Each coin is a separate sub-account                             |
| Risk per trade         | 0.5% of the sub-account's equity, measured at the stop                                                            |
| Leverage               | Position notional at most 1× the sub-account's equity                                                             |
| Stop and target        | Fixed when the position opens. Nothing moves them                                                                 |
| Daily loss             | Realized loss of 2% of the equity held at 00:00 UTC blocks new entries until the next UTC day. Exits still run    |
| One position at a time | At most one per coin per strategy. A signal is ignored while a position is open or an entry is waiting to be made |
| Never                  | Averaging down, adding to a position, martingale sizing                                                           |

## Fill model

- Signals use **closed** bars only. A signal at a bar's close fills at the
  **next 5-minute bar's open**, and pays the fill cost.
- Stops and targets are checked on every 5-minute bar from the entry bar on,
  against that bar's low and high. If one bar touches both, **the stop wins**.
- A stop fills at the stop price, or at the bar's open if the bar opened beyond
  it (a gap). A target fills at the target price.
- A time stop exits at the open of the first 5-minute bar that opens at or
  after the entry time plus the maximum hold. It is checked before the stop and
  target on that bar.
- Size: (0.5% × equity) ÷ stop distance, cut down to the 1× cap. Stop and
  target distances are worked out at the signal and measured from the actual
  fill price.

## Bars and indicators

Coinbase public 5-minute candles, UTC. 15-minute and 4-hour bars are built from
them on UTC boundaries. A strategy evaluates a 15-minute bar at the close of the
5-minute bar that ends on that boundary. If that 5-minute bar does not exist
(no trades in it), that evaluation is skipped. Missing 5-minute bars are not
filled in. Indicators run over the bars that exist.

Indicators are the repo's existing definitions in
`packages/core/src/indicators`: SMA, EMA seeded with an SMA, and Wilder's RSI
and ATR. The smoothed ones are computed over a fixed trailing window, the same
in the backtest and in the paper engine:

- EMA on 4-hour bars: the trailing 300 bars.
- RSI(14) and ATR(14) on 15-minute bars: the trailing 300 bars.

A strategy trades only once every window it reads is full. Until then it stays
flat.

The simulation lives in `packages/futures`, written after this protocol was
committed. The paper engine (`apps/futures-engine`) uses the same code, so the
paper bot runs the rules that were tested.

## The four strategies

The parameters are conventional defaults chosen before any run. None is tuned,
and no other value is tried.

### F1 — Flush catcher: fade forced moves (5-minute bars; BTC, ETH, SOL)

At every 5-minute close, bar `i`:

- `r = ln(close[i] / close[i-3])`, the last 15 minutes.
- `σ` = population standard deviation of that same 3-bar log return over the
  previous 2,016 bars (7 days): `r` at bars `i-2016 … i-1`.
- `V` = total volume of bars `i-2 … i`. `Vmed` = the median of that 3-bar
  volume total over the previous 2,016 bars.
- `move = |close[i] - close[i-3]| / close[i-3]`.

**Long** when `r ≤ -4σ`, `V ≥ 3 × Vmed` and `move ≥ 1.0%`. **Short** when
`r ≥ +4σ`, `V ≥ 3 × Vmed` and `move ≥ 1.0%`. Stop and target are both
`0.5 × |close[i] - close[i-3]|` from the entry price. Maximum hold: 4 hours.

Why: a fast move on heavy volume is often forced: liquidations and stop runs.
Forced traders pay for immediacy, and the price partly snaps back.

### F2 — Squeeze breakout (15-minute bars; BTC, ETH, SOL)

- Bollinger bands (20, 2) on 15-minute closes. The middle is SMA(20). The bands
  are the middle ± 2 × the population standard deviation of the last 20 closes.
  Bandwidth = (upper − lower) ÷ middle.
- A **squeeze bar** has a bandwidth at or below the lowest bandwidth of the
  previous 672 bars (7 days).
- At a 15-minute close `k`, if any of bars `k-4 … k-1` was a squeeze bar:
  **long** if `close[k] > upper[k]`, **short** if `close[k] < lower[k]`.
- Stop at 1.5 × ATR(14), target at 3 × ATR(14), on 15-minute bars at `k`.
  Maximum hold: 24 hours.
- The signal is skipped if the target is less than 0.32% of the price away
  (twice the base round-trip cost).

Why: volatility clusters. Quiet stretches end in expansions, and the first
break tends to run.

### F3 — Trend pullback, long or short (15-minute entries on a 4-hour trend; BTC, ETH, SOL)

- Trend, from the most recent closed 4-hour bar: **up** when EMA(20) > EMA(50)
  and close > EMA(50); **down** when EMA(20) < EMA(50) and close < EMA(50);
  otherwise none.
- At a 15-minute close `k`: **long** if the trend is up and RSI(14) crosses up
  through 40 (`rsi[k-1] < 40 ≤ rsi[k]`). **Short** if the trend is down and
  RSI(14) crosses down through 60 (`rsi[k-1] > 60 ≥ rsi[k]`).
- Stop at 2 × ATR(14), target at 3 × ATR(14), on 15-minute bars at `k`.
  Maximum hold: 48 hours.
- The signal is skipped if the target is less than 0.32% of the price away.

Why: trade with the larger trend, and enter as a pullback ends. Shorting lets
it earn in falling markets, where the regime filter lost in 2025–26.

### F4 — Cross-sectional momentum, "any crypto" (daily bars; the futures universe)

The universe, frozen on 2026-10-06, is every crypto perpetual-style future on
Coinbase Derivatives that has a Coinbase USD spot pair, except PAXG (a gold
token). That's 23 coins: AAVE, ADA, AVAX, BCH, BNB, BTC, DOGE, DOT, ENA, ETH,
HBAR, HYPE, LINK, LTC, NEAR, ONDO, PEPE, SHIB, SOL, SUI, XLM, XRP and ZEC.

- A coin is **eligible** on a rebalance date if it has a daily close for each of
  the previous 22 days.
- Every Monday at 00:00 UTC, on the Sunday close: rank the eligible coins by
  their 21-day return. With `N` eligible, and at least 6 needed to trade,
  **long the top ⌊N/3⌋ and short the bottom ⌊N/3⌋**. Each long and each short
  gets 0.5 ÷ ⌊N/3⌋ of equity, so gross exposure is 1×. Fills are at Monday's
  open.
- A position that stays in its leg is resized to its target. Every other
  position is closed. Every change in notional pays the fill cost.
- A disaster stop sits 20% against the price of the position's most recent
  fill, checked against daily highs and lows, with the same gap rule. A stopped
  coin stays out until the next rebalance.
- Funding as above. The daily-loss rule does not apply: positions are held for
  a week. The 1× cap applies to gross exposure.

Why: this is a version of the "trade any crypto" approach the owner's friend
reports +200% from over five months, though his rules are not known.
Cross-sectional momentum, meaning long recent winners and short recent losers
with portfolios formed on past weeks' returns, is documented in crypto (Liu,
Tsyvinski and Wu, _Journal of Finance_, 2022).

**Survivorship warning.** The universe is today's survivors. Coins Coinbase
has delisted are missing: its API still shows only 4 delisted USD pairs, mostly
renames. A long-short ranking is less exposed to this than a long-only one,
but the result carries the caveat.

## Data and windows

| Window          | Trading                 | Notes                                                    |
| --------------- | ----------------------- | -------------------------------------------------------- |
| **Development** | 2019-01-01 → 2023-07-01 | SOL from 2021-09-01. F4 from the first date it has N ≥ 6 |
| **Holdout**     | 2023-07-01 → 2026-10-01 | Run once, after the development results are committed    |

Earlier bars are used only to warm up indicators. Each window starts flat, with
fresh capital.

The data is Coinbase public candles:

- 5-minute candles for BTC-USD and ETH-USD from 2018-10-01, and for SOL-USD from
  its listing on 2021-06-17. That leaves at least 76 days of warmup before
  either window.
- Daily candles for the F4 universe from each coin's listing.

It is fetched after this protocol is pushed, and each file's SHA-256 is
recorded with the results.

Before any strategy runs:

- (a) Count the missing 5-minute bars per coin per year.
- (b) Check that the 5-minute bars add up to Coinbase's own daily candles, with
  closes within 0.05%. A coin that fails this on more than 1% of days is
  investigated before anything runs, and any fix is documented.
- (c) For 2025-07-21 → 2026-10-01, compare the BTC, ETH and SOL perpetual
  candles with spot, if the public API serves them. This is reported only.

## Scoring

For each strategy and window:

- The **daily return** of each sub-account, from its equity at 00:00 UTC with
  open positions marked at the close. A strategy's **pooled daily return** is
  the mean over the sub-accounts trading that day. F4 is a single account.
- Annualized return: daily returns compounded and scaled to 365 days.
- t-statistic: mean daily return ÷ (sample standard deviation ÷ √days).
- Maximum drawdown of the pooled equity curve at daily closes.
- Trades are round trips. For F4, a trade is a position from entry to full
  exit. Positions still open at the end of a window are closed at the last
  close and pay the exit cost.

Also reported, but not part of the verdict: results per coin, long versus
short, win rate, average winner and loser, expectancy per trade, fees and
funding paid, and exits by reason.

## Decision rule

A strategy **passes** only if all of the following hold:

1. Development: annualized return > 0 at base costs.
2. Holdout: annualized return > 0 at base costs.
3. Holdout: t-statistic ≥ 2.5. Four strategies are tested, and 2.5 is a little
   stricter than a Bonferroni-adjusted one-sided 5% test.
4. Holdout: annualized return > 0 at stress costs (16 bps per fill).
5. Holdout: return > 0 in each half, 2023-07-01 → 2025-02-15 and
   2025-02-15 → 2026-10-01.
6. Holdout: at least 200 trades.
7. Holdout: maximum drawdown no deeper than 25%.
8. F1–F3 only: holdout return > 0 on at least 2 of the 3 coins.

## What a pass would and would not mean

A strategy that passes goes to forward paper trading in the futures paper
engine, which is being built alongside this experiment. Real money needs more:

- at least 4 weeks and 50 trades of forward paper trading,
- net positive results after costs over that time,
- and the owner's decision.

A pass does not justify leverage above 1×. Live trading adds a weekly rule:
down 5% in a week means back to paper and a review.

If nothing passes, nothing goes live. The paper engine may keep running all
four strategies to test the machinery and to collect forward data. That data is
labeled as such, and it cannot turn a failed strategy into a live one. A new
idea needs a new experiment.

## Disclosure of prior knowledge

Before writing this, the author had seen:

- BTC's daily history for 2015–2026, and ETH's and SOL's daily history, through
  EXPERIMENT-001 to EXPERIMENT-007.
- ta-ensemble-v1 on BTC hourly bars from 2022-11 to 2025-01: a profit factor of
  1.39 before costs and −86% after (`docs/BACKTEST.md`).
- Descriptive statistics measured on 2026-10-06 for BTC, ETH, SOL, XRP and
  DOGE: median bar ranges and moves at 1 minute (last 7 days), 5 and 15 minutes
  (last 60 days), and 1 hour, 4 hours and 1 day (last 365 days), and the share
  of bars whose range exceeded several cost levels.
- Live spreads.
- What the top 96 coins returned when held over 2026-05-06 → 2026-10-05, and
  their drawdowns: BTC +5%, ETH +15%, SOL +36%, six coins tripled.
- The list of US perpetual futures, and the start dates of their spot
  histories.

None of the four strategies' entry or exit rules has been run on any data.
The strategies are textbook ideas, and the parameters are their usual
defaults, not values chosen from this data. The holdout overlaps the year of
bar ranges listed above. Like the previous experiments' disclosures, this
weakens a pass more than a fail.

## Rules of conduct

1. The code implements exactly the rules above. Where it has to decide
   something this text leaves open, it takes the conservative choice, and the
   process notes say so.
2. Development runs first, and its results are committed before the holdout
   runs. The holdout runs for every strategy, whatever its development result.
3. Each strategy runs once per window at base costs and once at stress costs.
   A re-run is allowed only for a bug that does not change the rules, and the
   process notes say why.
4. No change to strategies, costs, windows or criteria after a holdout result
   has been seen. A new idea is a new experiment.
5. Results are appended below this line, unedited.

---

## Results

_(appended after the runs)_
