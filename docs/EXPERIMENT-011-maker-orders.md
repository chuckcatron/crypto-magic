# Experiment 011 — Maker limit orders against market orders

**Status: PRE-REGISTERED.** This protocol was written and committed before the
trade data was downloaded or any result below was computed. The commit history
is the evidence of that order. Nothing in this section may be edited after
results exist.

## Question

The bot buys and sells with market orders, and the backtests charge 65 bps a
fill (60 bps taker fee plus 5 bps slippage). A resting limit order pays about
40 bps as a maker. But a limit order may not fill, and when price runs away from it the
bot has to chase. Does posting a limit order and waiting up to an hour, then
crossing if it has not filled, cost less than a market order on BTC, ETH and
SOL?

The fee saving is known: 25 bps on every fill. The open question is how much of
it is given back to orders that do not fill and to price moving against a
waiting order.

## Policy (fixed in advance, not tuned)

An order is placed at **00:00:00 UTC**, the time of the daily bar the strategy
trades on. For each coin and each day from 2025-10-01 to 2026-09-29 (364 days),
a **buy** and a **sell** are simulated independently, from the Binance spot
trade tape for BTCUSDT, ETHUSDT and SOLUSDT.

- `P_ref` = the price of the first trade at or after 00:00:00. This stands in
  for the "next open" the backtests fill at.
- **Baseline (market order):** fills at `P_ref`, paying 65 bps.
- **Maker policy:** a limit at `P0`, the price of the last trade before
  00:00:00 (a stand-in for the touch). A buy fills when a later trade prints
  **strictly below** `P0`; a sell when one prints **strictly above** it. The
  order waits up to **60 minutes**. If it has not filled by then, it crosses as
  a market order at the first trade at or after 01:00:00, paying 65 bps.
  A fill pays 40 bps.

Cost is measured against `P_ref`, in basis points, per side:

- buy cost = (price paid including fee − `P_ref`) / `P_ref`;
- sell cost = (`P_ref` − proceeds after fee) / `P_ref`.

The baseline costs 65 bps on every event by construction, so the **saving** of
an event is 65 minus the maker policy's cost.

60 minutes and the strict through-trade fill rule are fixed here and **not
tuned**. No other wait, limit price or fill rule is tried as part of the verdict.
The strict rule is the conservative one: it assumes the order is last in the
queue and fills only when price trades through it. As a context bound, the
results also report the optimistic rule (a trade at **or** through `P0`), which
is not used for the verdict.

## Data

Binance public data, `data.binance.vision`, spot monthly `aggTrades` zips for
BTCUSDT, ETHUSDT and SOLUSDT, 2025-09 to 2026-09 (13 files per coin; 2025-09 is
needed only for the last trade before the first event). Each file is checked
against Binance's published `.CHECKSUM` before use, and the SHA-256 of every
file is recorded in the results.

Timestamps are read as microseconds where they have 16 digits and
milliseconds where they have 13. Only trades inside the windows that the
policy needs are kept, from 10 minutes before to 70 minutes after each
00:00:00 UTC.

**What this data is not.** It is USDT-quoted Binance spot, not Coinbase USD. It
has no order-book depth and no queue position, so the strict fill rule is a
stand-in for being at the back of the queue. The 40 bps maker fee is the rate
the bot's Coinbase tier is expected to pay, not an observed fee. A fill on a
trade tape does not prove a real order would have filled. The result says
whether the policy could pay, not that it will.

## Windows

The year is split in two, by date, before any result is seen:

| Half        | Dates                   | Days |
| ----------- | ----------------------- | ---- |
| Development | 2025-10-01 → 2026-03-31 | 182  |
| Holdout     | 2026-04-01 → 2026-09-29 | 182  |

Nothing is tuned on either half, so the split exists to test that the result
holds in both, not to choose parameters.

## Decision rule

For each coin and each half (6 cells), take the mean saving per event over that
half's days, buys and sells together. The confidence interval is a bootstrap
over **days** (a day's buy and sell are resampled together), 10,000 resamples,
seed 1.

The policy **passes** only if, in **all 6 cells**:

1. the mean saving is at least **5 bps**, and
2. the 95% interval's lower bound is above **0**.

If any cell fails, orders stay as market orders.

Reported for context, not part of the verdict:

- the fill rate (the share of orders that fill within the hour) for buys and
  sells, per coin and half;
- the mean cost of orders that fill against orders that cross, to show how much
  the chase costs;
- the saving on days when the day's return was above +2% for buys and below −2%
  for sells (the days a trend strategy tends to trade);
- the same figures under the optimistic fill rule.

## What a pass would and would not mean

A pass would support building maker orders into the engine as a separate,
reviewed change, tested on paper first. The fee-sensitivity run in CLAUDE.md
found that going from 60 to 25 bps taker is worth about 3 points a year on the
regime strategy at full exposure, so a pass is worth at most a couple of points
a year, and only because the strategy trades rarely.

It would not show real fills. A real order's queue position, partial fills and
Coinbase's actual behavior are not in the tape. It says nothing about the
strategy's signals. The regime strategy trades a handful of times a year, so
this test uses every day, not only the days it trades.

## Rules of conduct

1. Data is downloaded and the policy is run once per coin, after this protocol
   is committed and pushed. No other wait, limit price, fill rule, hour or
   period is tried.
2. If the script has a bug, it is fixed, the fix is described, and every run is
   repeated once. The verdict is read from the repeated runs, and the first runs
   are kept in the results.
3. Results are appended below this line, unedited.

---

## Results

_(appended after the runs)_

The protocol was committed as `a531119` and on GitHub at 21:36:04Z on
2026-10-06. The downloader and simulation (`scripts/fetch-binance-trade-windows.sh`,
`scripts/maker-orders.mjs`, with 5 unit tests) followed as `721122d`. The three
runs, one per coin, were each done once, starting 21:54:05Z. The script needed
no fixes, so rule 2 was not triggered.

### The runs: strict fill rule (the verdict)

| Coin    | Half        | Days | Mean saving (bps) | 95% interval | Buy fill | Sell fill | Cell |
| ------- | ----------- | ---- | ----------------- | ------------ | -------- | --------- | ---- |
| BTCUSDT | development | 182  | 23.7              | 22.3 to 24.7 | 100%     | 97%       | PASS |
| BTCUSDT | holdout     | 182  | 23.5              | 22.3 to 24.5 | 97%      | 98%       | PASS |
| ETHUSDT | development | 182  | 23.2              | 21.6 to 24.4 | 99%      | 97%       | PASS |
| ETHUSDT | holdout     | 182  | 23.6              | 22.3 to 24.6 | 97%      | 99%       | PASS |
| SOLUSDT | development | 182  | 22.5              | 20.2 to 24.3 | 98%      | 97%       | PASS |
| SOLUSDT | holdout     | 182  | 22.3              | 20.6 to 23.6 | 95%      | 98%       | PASS |

### Context (not part of the verdict)

Optimistic fill rule (a trade at or through the limit also fills):

| Coin    | Half        | Mean saving (bps) | 95% interval | Buy fill | Sell fill |
| ------- | ----------- | ----------------- | ------------ | -------- | --------- |
| BTCUSDT | development | 24.8              | 24.3 to 25.0 | 100%     | 99%       |
| BTCUSDT | holdout     | 24.1              | 22.9 to 24.9 | 98%      | 100%      |
| ETHUSDT | development | 24.7              | 24.0 to 25.0 | 99%      | 100%      |
| ETHUSDT | holdout     | 24.6              | 24.0 to 25.0 | 99%      | 100%      |
| SOLUSDT | development | 24.9              | 24.6 to 25.0 | 99%      | 100%      |
| SOLUSDT | holdout     | 24.5              | 23.8 to 25.0 | 99%      | 100%      |

Saving on the days a trend strategy tends to trade (strict rule): buys on days the price rose more than 2%, sells on days it fell more than 2%.

| Coin    | Half        | Up days | Buy saving (bps) | Down days | Sell saving (bps) |
| ------- | ----------- | ------- | ---------------- | --------- | ----------------- |
| BTCUSDT | development | 26      | 25.0             | 36        | 18.5              |
| BTCUSDT | holdout     | 20      | 15.2             | 21        | 23.0              |
| ETHUSDT | development | 38      | 25.0             | 51        | 20.9              |
| ETHUSDT | holdout     | 32      | 22.8             | 32        | 25.0              |
| SOLUSDT | development | 41      | 25.2             | 58        | 17.9              |
| SOLUSDT | holdout     | 38      | 21.1             | 42        | 22.9              |

Orders that filled all saved about 25 bps, which is the fee gap (65 minus 40). The orders that did not fill crossed after the hour and lost between 14 and 116 bps each against a market order on average per cell (the worst single events were −94 to −296 bps), but there were few of them (strict rule, over 364 days):

| Coin    | Buys that crossed | Sells that crossed |
| ------- | ----------------- | ------------------ |
| BTCUSDT | 6                 | 9                  |
| ETHUSDT | 8                 | 6                  |
| SOLUSDT | 13                | 9                  |

### Data (SHA-256 of each downloaded zip, first 16 characters)

Every file matched Binance's published `.CHECKSUM` before use.

| Month   | BTCUSDT            | ETHUSDT            | SOLUSDT            |
| ------- | ------------------ | ------------------ | ------------------ |
| 2025-09 | `e61d2a08e23cdd7f` | `0562362f4a33e8d3` | `ddf0aeb8349a3824` |
| 2025-10 | `6f55e6b44e12de9a` | `b95d4c11602280e7` | `4750ff8fc894714f` |
| 2025-11 | `84ee7d360e3b1148` | `9f8fde4a61d8936c` | `1a2c4e03044c454a` |
| 2025-12 | `60a448ceac1f6ffa` | `4cd986ea5263c863` | `58e474d161409f83` |
| 2026-01 | `522a9194a0499b0a` | `b88bc2e7ad58ffb1` | `ef272cef60c0f580` |
| 2026-02 | `25cc3860ed725d78` | `4908004537da5a77` | `b329b1f267c86383` |
| 2026-03 | `12be07b8f6c7d747` | `aa2df310af7d0344` | `ffd709d3839739fc` |
| 2026-04 | `92deb20c0d4518ab` | `ef90816acf0302c9` | `44eb85a4f0b866ae` |
| 2026-05 | `f3948dc975045a65` | `a3019c5d10b69959` | `c52e8a1c79565c0f` |
| 2026-06 | `f6f21f865a3a120e` | `f948423d491003d9` | `86cbe0b01fdc78ae` |
| 2026-07 | `61dd3e40e2eb7c61` | `8afac2b28ee9f2ad` | `31dc9a965cac953f` |
| 2026-08 | `b9a69fd3482b5947` | `c7a905f8d1ea1c5a` | `24f315815feb0db5` |
| 2026-09 | `fb36df9684b5d6c2` | `45f993b92345d33e` | `e5c7af99fd9d54fa` |

## Verdict

**The maker policy passes.** In all six cells (3 coins × 2 halves) the mean
saving was above 5 bps (22.3 to 23.7 bps) and the lower end of the 95% interval
was above zero (the lowest was 20.2 bps, SOL development). Waiting up to an hour
with a limit order cost less than a market order on BTC, ETH and SOL, in both
halves of the year.

A pass supports building maker orders into the engine as a separate, reviewed
change, tested in paper mode first. It does not change the bot by itself.

## How far to trust it

The pass is real as registered, but it is a lenient test, and these points
should weaken confidence in it:

- **Nearly all of the saving is the fee gap.** Every filled order saved about
  25 bps by construction (65 minus 40). The result says that on these three coins
  almost every order would have filled, so little was given back. It is not
  evidence that the entry price improved.
- **Fill rates of 95–100% are the number to doubt.** A buy "fills" when any trade
  prints below the last price within the hour, and on a liquid pair the price
  nearly always ticks below the last print. The strict rule covers price
  equality but not queue position: it cannot see how many orders were ahead of
  a real order. A real resting order could fill much less often.
- **The limit price is a stand-in.** `P0` is the last trade, not the bid or ask.
  If the last trade was at the ask, a real buy at that price would be a
  marketable order and pay the taker fee.
- **The days that matter are the weak spot.** On days the price rose more than 2%
  (when a trend strategy buys), the buy saving fell as low as 15.2 bps (BTC,
  holdout) against 25 on a typical day. On large down days, sell savings were
  17.9 to 25.0 bps. The saving is still positive there, but it shrinks when it
  matters most.
- **The tail is large.** A single order that did not fill lost up to 296 bps
  against a market order (SOL sell). A handful of unfilled orders a year is
  fine, but a strategy that trades only a few times a year feels each one.
- **Not Coinbase.** The tape is Binance USDT spot. The 40 bps maker fee is the
  expected Coinbase rate, not an observed one.

## What it would be worth

The fee-sensitivity run in CLAUDE.md puts 60 → 25 bps taker at about 3 points a
year on the regime strategy. A saving of about 23 bps a fill, at most, is worth
a couple of points a year, and the strategy trades rarely. The 2025–2026
backtest loss is not fixed by this.

## Reproduce

```bash
for s in BTCUSDT ETHUSDT SOLUSDT; do bash scripts/fetch-binance-trade-windows.sh $s 2025-09 2026-09; done
for s in BTCUSDT ETHUSDT SOLUSDT; do node scripts/maker-orders.mjs --symbol $s --out /tmp/$s.json; done
node --test scripts/maker-orders.test.mjs
```
