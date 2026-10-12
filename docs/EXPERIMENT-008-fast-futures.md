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

The protocol was committed as `46751fd` at 15:58:59Z on 2026-10-06 and was on
GitHub by 15:59:02Z. Everything below was produced after that.

### Data, fetched after the protocol was pushed

`scripts/fetch-coinbase-history.mjs` gained `--granularity` and `--to`, retries
on network errors, and accepts futures product IDs. These are tooling changes
only.

| File          | 5-minute bars | From       | To         | SHA-256 (first 16) |
| ------------- | ------------- | ---------- | ---------- | ------------------ |
| `btc-5m.csv`  | 841,043       | 2018-10-01 | 2026-09-30 | `662af1770005886b` |
| `eth-5m.csv`  | 841,109       | 2018-10-01 | 2026-09-30 | `6e044150ad83cd6f` |
| `sol-5m.csv`  | 555,949       | 2021-06-17 | 2026-09-30 | `8cad8df34f9ea8c0` |
| `daily/*.csv` | 23 files      | listing    | 2026-09-30 | listed below       |

Daily files, SHA-256 (first 16): AAVE `ea50ce1981ed1954`, ADA
`1520bc2af1b4408b`, AVAX `70bff46de68a1198`, BCH `47d39517da9fdb6b`, BNB
`717529df551dff03`, BTC `fbdc8b9418a8fe01`, DOGE `35cddc0321b6416f`, DOT
`07ede0b0f24828de`, ENA `ba01d82b1b08ee5f`, ETH `3704a806302e52ae`, HBAR
`e9fec272fedcbce9`, HYPE `19be7853150ac659`, LINK `d3f80b8661a4fe13`, LTC
`d8af4dc443d74209`, NEAR `07bdb220df7f9159`, ONDO `8945ed6e39060914`, PEPE
`7731ee675e7c4760`, SHIB `d3cafd84c71650f3`, SOL `e92e9b1d7449b6c5`, SUI
`96d184f86a8166ad`, XLM `21c527da66e76bc6`, XRP `92e08261eb1d60fa`, ZEC
`f369f711eeb12903`.

**(a) Missing 5-minute bars, by year.** A year has 105,120 of them. SOL's
history starts in 2021.

| Coin    | 2018 | 2019 | 2020 | 2021 | 2022 | 2023 | 2024 | 2025 | 2026 |
| ------- | ---- | ---- | ---- | ---- | ---- | ---- | ---- | ---- | ---- |
| BTC-USD | 32   | 105  | 108  | 11   | 1    | 63   | 24   | 70   | 79   |
| ETH-USD | 11   | 53   | 107  | 11   | 1    | 63   | 25   | 76   | 80   |
| SOL-USD | —    | —    | —    | 13   | 1    | 68   | 41   | 71   | 80   |

**(b) The 5-minute bars against Coinbase's daily candles.** BTC: 0 of 2,922
days differ by more than 0.05%. ETH: 0 of 2,922. SOL: 22 of 1,932 (1.14%),
which is over the 1% line, so it was investigated before anything ran.

All 22 days fall between May and November 2023, when SOL traded between $14
and $40 and its price moved in $0.01 steps. One step was then 0.03–0.07% of
the price. On every one of those days the two closes differ by 1 to 3 cents.
Opens, highs and lows are identical. The cause is rounding of the day's last
trade, not missing or wrong data. Nothing was changed.

**(c) Perpetuals against spot**, 5-minute closes, 2025-07-21 → 2026-10-01:

| Perpetual         | Bars matched | Median basis | 5th–95th percentile | Beyond ±0.1% | Return correlation |
| ----------------- | ------------ | ------------ | ------------------- | ------------ | ------------------ |
| `BIP-20DEC30-CDE` | 123,259      | +0.019%      | −0.037% to +0.080%  | 2.5%         | 0.962              |
| `ETP-20DEC30-CDE` | 122,999      | +0.028%      | −0.055% to +0.119%  | 9.9%         | 0.950              |
| `SLP-20DEC30-CDE` | 109,067      | +0.015%      | −0.090% to +0.124%  | 12.6%        | 0.921              |

The perpetuals trade at a small premium to spot, and their 5-minute moves
track spot closely. Spot is a fair proxy. Where the two differ, a perpetual
trader sees extra noise, which costs more, not less.

### Development, 2019-01-01 → 2023-07-01 (recorded before the holdout was run)

Run once at 16:22:35Z, at base and stress costs. Pooled across coins:

| Strategy | Annualized | Total   | t-stat | Max drawdown | Trades | Annualized at stress costs |
| -------- | ---------- | ------- | ------ | ------------ | ------ | -------------------------- |
| F1       | −37.01%    | −87.50% | −11.60 | −87.52%      | 4,694  | −54.76%                    |
| F2       | −7.04%     | −27.98% | −4.12  | −30.05%      | 657    | −14.32%                    |
| F3       | −35.32%    | −85.91% | −7.83  | −86.01%      | 5,885  | −58.87%                    |
| F4       | −10.33%    | −38.76% | −0.40  | −54.24%      | 608    | −13.50%                    |

Per coin, base costs. The P&L columns are a percentage of the sub-account's
starting equity.

| Strategy | Coin | Annualized | Max drawdown | Trades | Win rate | Long P&L | Short P&L | Fees and funding | Exits                                 |
| -------- | ---- | ---------- | ------------ | ------ | -------- | -------- | --------- | ---------------- | ------------------------------------- |
| F1       | BTC  | −39.67%    | −89.80%      | 1,909  | 46.6%    | −38.95%  | −50.76%   | 67.13%           | stop 945, target 844, time 120        |
| F1       | ETH  | −39.83%    | −89.90%      | 1,998  | 46.0%    | −40.90%  | −48.93%   | 58.63%           | stop 1,019, target 879, time 100      |
| F1       | SOL  | −17.56%    | −32.28%      | 787    | 52.0%    | −10.85%  | −18.92%   | 41.46%           | stop 372, target 397, time 18         |
| F2       | BTC  | −7.17%     | −31.32%      | 270    | 35.2%    | −6.36%   | −22.07%   | 35.87%           | stop 175, target 95                   |
| F2       | ETH  | −7.54%     | −32.14%      | 268    | 34.3%    | −14.20%  | −15.50%   | 31.26%           | stop 176, target 92                   |
| F2       | SOL  | −9.81%     | −18.30%      | 119    | 30.3%    | −12.81%  | −4.40%    | 11.57%           | stop 83, target 36                    |
| F3       | BTC  | −39.52%    | −89.81%      | 2,371  | 41.0%    | −56.01%  | −33.58%   | 110.72%          | stop 1,394, target 968, time 8, end 1 |
| F3       | ETH  | −35.51%    | −86.35%      | 2,467  | 40.5%    | −52.20%  | −33.90%   | 107.55%          | stop 1,467, target 996, time 4        |
| F3       | SOL  | −31.51%    | −50.82%      | 1,047  | 39.7%    | −34.19%  | −15.78%   | 44.71%           | stop 630, target 416, time 1          |
| F4       | all  | −10.33%    | −54.24%      | 608    | 44.6%    | +45.17%  | −83.93%   | 47.71%           | rebalance 417, stop 181, end 10       |

**Every strategy already fails criterion 1.** Under rule 2 the holdout still
runs for all four.

Noted without adjusting anything:

- **F1–F3 have no edge before costs, so this is not mainly a cost problem.**
  Measured as the average price move captured per trade, against a round trip
  that costs about 16 bps:

  | Strategy | BTC      | ETH      | SOL       |
  | -------- | -------- | -------- | --------- |
  | F1       | −3.6 bps | −4.5 bps | +8.6 bps  |
  | F2       | +3.8 bps | −0.2 bps | −18.7 bps |
  | F3       | +0.7 bps | +1.0 bps | +1.2 bps  |

  Zero-ish before costs, minus 16 bps a trade, thousands of times, gives
  −86% to −88% for F1 and F3. ta-ensemble-v1's hourly signal at least had an
  edge before costs (a profit factor of 1.39). These have none.

- **F4's long leg made money, and its short leg lost almost twice as much.**
  The long side made +45% of starting equity. The short side lost 84%, and
  nearly all of that came in the 2020–21 bull market, when even the weakest
  coins rose: −70% in 2020 and −46% in 2021. Shorts made +32% in 2022.

### Holdout, 2023-07-01 → 2026-10-01 (run once, nothing changed)

Run once at 16:28:41Z, after the development results were on GitHub
(`29de005`, pushed 16:28:30Z). Same input files. Pooled across coins:

| Strategy | Annualized | Total   | t-stat | Max drawdown | Trades | Annualized at stress costs |
| -------- | ---------- | ------- | ------ | ------------ | ------ | -------------------------- |
| F1       | −31.75%    | −71.15% | −9.23  | −71.32%      | 3,575  | −51.44%                    |
| F2       | −7.09%     | −21.28% | −5.28  | −21.28%      | 445    | −13.16%                    |
| F3       | −47.28%    | −87.56% | −10.45 | −87.62%      | 5,434  | −68.78%                    |
| F4       | −2.09%     | −6.64%  | 0.06   | −34.63%      | 912    | −5.70%                     |

Per coin, base costs, as a percentage of starting equity:

| Strategy | Coin | Annualized | Max drawdown | Trades | Win rate | Long P&L | Short P&L | Fees and funding | Exits                                  |
| -------- | ---- | ---------- | ------------ | ------ | -------- | -------- | --------- | ---------------- | -------------------------------------- |
| F1       | BTC  | −31.72%    | −71.24%      | 965    | 48.7%    | −29.01%  | −42.11%   | 70.48%           | stop 479, target 451, time 35          |
| F1       | ETH  | −39.19%    | −80.56%      | 1,351  | 48.0%    | −40.52%  | −39.67%   | 73.91%           | stop 676, target 623, time 52          |
| F1       | SOL  | −23.97%    | −59.53%      | 1,259  | 51.0%    | −20.23%  | −38.79%   | 72.83%           | stop 602, target 631, time 26          |
| F2       | BTC  | −5.17%     | −15.86%      | 122    | 35.2%    | −6.48%   | −9.38%    | 18.37%           | stop 79, target 43                     |
| F2       | ETH  | −10.56%    | −30.46%      | 160    | 28.1%    | −15.63%  | −14.83%   | 21.27%           | stop 115, target 45                    |
| F2       | SOL  | −5.56%     | −17.91%      | 163    | 34.4%    | −3.59%   | −13.40%   | 20.22%           | stop 107, target 56                    |
| F3       | BTC  | −49.16%    | −89.04%      | 1,738  | 40.7%    | −44.39%  | −44.55%   | 96.87%           | stop 1,020, target 697, time 20, end 1 |
| F3       | ETH  | −48.98%    | −88.83%      | 1,781  | 38.7%    | −39.71%  | −49.11%   | 73.44%           | stop 1,082, target 683, time 15, end 1 |
| F3       | SOL  | −44.36%    | −85.46%      | 1,915  | 38.4%    | −51.41%  | −33.75%   | 66.01%           | stop 1,178, target 734, time 2, end 1  |
| F4       | all  | −2.09%     | −34.63%      | 912    | 43.2%    | +55.41%  | −62.06%   | 53.85%           | rebalance 662, stop 236, end 14        |

Holdout halves, pooled, base costs:

| Strategy | 2023-07-01 → 2025-02-15 | 2025-02-15 → 2026-10-01 |
| -------- | ----------------------- | ----------------------- |
| F1       | −38.44%                 | −53.14%                 |
| F2       | −11.63%                 | −10.92%                 |
| F3       | −63.70%                 | −65.71%                 |
| F4       | +5.13%                  | −11.20%                 |

### Applying the decision rule

| Criterion                      | F1               | F2               | F3               | F4                |
| ------------------------------ | ---------------- | ---------------- | ---------------- | ----------------- |
| 1. Development annualized > 0  | **FAIL** −37.01% | **FAIL** −7.04%  | **FAIL** −35.32% | **FAIL** −10.33%  |
| 2. Holdout annualized > 0      | **FAIL** −31.75% | **FAIL** −7.09%  | **FAIL** −47.28% | **FAIL** −2.09%   |
| 3. Holdout t-stat ≥ 2.5        | **FAIL** −9.23   | **FAIL** −5.28   | **FAIL** −10.45  | **FAIL** 0.06     |
| 4. Holdout > 0 at stress costs | **FAIL** −51.44% | **FAIL** −13.16% | **FAIL** −68.78% | **FAIL** −5.70%   |
| 5. Holdout > 0 in each half    | **FAIL** both    | **FAIL** both    | **FAIL** both    | **FAIL** 2nd half |
| 6. Holdout trades ≥ 200        | PASS 3,575       | PASS 445         | PASS 5,434       | PASS 912          |
| 7. Holdout max drawdown ≤ 25%  | **FAIL** −71.32% | PASS −21.28%     | **FAIL** −87.62% | **FAIL** −34.63%  |
| 8. Holdout > 0 on 2 of 3 coins | **FAIL** 0 of 3  | **FAIL** 0 of 3  | **FAIL** 0 of 3  | n/a               |
| **Verdict**                    | **FAIL**         | **FAIL**         | **FAIL**         | **FAIL**          |

## Verdict

**All four strategies fail.** None goes to forward paper trading as a
candidate, and nothing goes live. The paper engine may run them only to test
its machinery (see "What a pass would and would not mean").

## What this means

None of this changes the verdict.

1. **The fast strategies have no edge before costs, so cheaper fills will not
   rescue them.** The average price move each trade captured, in the holdout:

   | Strategy | BTC      | ETH      | SOL      |
   | -------- | -------- | -------- | -------- |
   | F1       | +0.7 bps | −3.1 bps | +5.6 bps |
   | F2       | +2.7 bps | −8.0 bps | +5.7 bps |
   | F3       | −0.0 bps | −5.6 bps | −9.1 bps |

   That is about zero, in both windows, on all three coins, against a round
   trip of about 16 bps. Maker orders at a few bps would shrink the loss.
   They would not turn zero into a gain. On 5- and 15-minute bars, these
   textbook ideas find nothing that the market's faster participants have not
   already taken.

2. **F4 is the only one with a real return before costs, and the assumed
   funding took most of it.** Per sub-account, as a percentage of starting
   equity:

   | Window      | Before costs | Fees   | Funding | After costs |
   | ----------- | ------------ | ------ | ------- | ----------- |
   | Development | +9.0%        | −11.8% | −35.9%  | −38.8%      |
   | Holdout     | +47.2%       | −12.4% | −41.5%  | −6.6%       |

   Its longs and shorts mostly cancelled each other. The longs won in rising
   years and the shorts in falling ones: +57% and −51% in 2024, −18% and +24%
   in 2025. The protocol charges funding to both sides. A real long-short book
   usually pays funding on its longs and collects it on its shorts, so the
   assumption is harshest on exactly this strategy. Even before any costs,
   though, development made about 2% a year. Testing F4 with real funding
   history would be a new, pre-registered experiment, run on data this one
   has now seen. That makes it weaker evidence from the start.

3. **This is the third time the same pattern has shown up.** ta-ensemble-v1
   on hourly bars (`docs/BACKTEST.md`), the cost measurement that opens this
   protocol, and now four fast strategies on cheap futures all point the same
   way. The only rule this repo trades after a pre-registered pass is still
   the slowest one, the 200-day regime filter on BTC.

## Process notes

### Implementation choices (fixed before the development run)

Rule 1 says the code takes the conservative choice wherever this protocol is
silent. These are the places it had to choose:

1. **The daily-loss halt is checked after each exit.** A decision at the close
   of the 23:55 bar is made at 00:00. The account starts the new day only when
   the next bar arrives, so a halt from the old day blocks that one decision.
2. **F1–F3 funding** is charged at exit, on the entry notional, for the hours
   held. An exit inside a bar is timed at that bar's close.
3. **A target fills at the target price,** even when a bar opens beyond it.
   There is no price improvement.
4. **F3 takes both RSI values from one computation** over the 300 bars ending
   at the current close.
5. **F4:**
   - A full day's funding is charged on every position held at the open,
     including one stopped out that day.
   - The 1× gross cap is applied at each rebalance. Positions are not trimmed
     between rebalances.
   - A coin with no bar on a Monday sits out that week.
   - A held coin with no bar at a rebalance is closed at its last close.
6. **Capital and warmup.** Each sub-account starts with $10,000, and sizes are
   fractional. Each window is fed 60 days of 5-minute bars before it starts;
   F3 needs 50.2. F4's calendar starts 40 days early.

The simulation is `packages/futures` (47 tests). One of those tests checks
that every strategy gives identical signals on a full history and on a series
rebuilt from a recent fetch, as the paper engine does. Commands:

```bash
node scripts/fetch-coinbase-history.mjs --product BTC-USD --granularity FIVE_MINUTE \
  --from 2018-10-01 --to 2026-10-01 > data/btc-5m.csv   # likewise eth (2018-10-01), sol (2021-06-17)
node scripts/fetch-coinbase-history.mjs --product AAVE-USD --to 2026-10-01 > data/daily/AAVE-USD.csv  # each universe coin
pnpm --filter @crypto-magic/futures validate-008
pnpm --filter @crypto-magic/futures experiment-008 --window dev
pnpm --filter @crypto-magic/futures experiment-008 --window holdout
```

### Runs

- Each window ran once at base costs and once at stress costs. Nothing was
  re-run. A run takes about 3 minutes, most of it F2's squeeze scan.
- Between the development run and the holdout, a lint pass made two
  typing-only edits: a type parameter on a `Map` in the rotation account, and
  one in a test. Neither changes behavior. The holdout ran on the committed
  code (`6ffccff`).
