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
