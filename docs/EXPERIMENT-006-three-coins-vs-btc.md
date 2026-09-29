# Experiment 006 — Three coins or BTC alone?

**Status: PRE-REGISTERED.** This protocol was written and committed before any
run below. The commit history is the evidence of that order. Nothing in this
section may be edited after results exist.

## Question

The paper bot trades BTC, ETH and SOL, a third of the account each, all under
the regime filter. The evidence for each coin alone is uneven:

- EXPERIMENT-001: BTC passed.
- EXPERIMENT-003: ETH failed its development window, and SOL passed its one
  window.
- EXPERIMENT-005: the filter failed on 26 of 27 other coins.

No experiment has tested what the bot actually runs, the three together. So the
decision the owner faces is untested: **at the same drawdown, does the
three-coin portfolio earn more than BTC alone?**

## This is not an out-of-sample test

Every bar used here has been looked at before. EXPERIMENT-003 ran the filter on
each coin over this window, and those results are known:

| Coin | Window                  | Annualized | Max drawdown |
| ---- | ----------------------- | ---------- | ------------ |
| ETH  | 2022-01-01 → 2026-09-29 | 14.72%     | −40.60%      |
| SOL  | 2022-02-01 → 2026-09-29 | 25.95%     | −62.86%      |

BTC's result over exactly this window has not been computed; its neighbours
have (2022-01-01 → 2025-01-07 on Bitstamp data: 52.01%; 2025-01-07 →
2026-09-29: −8.09%).

What is new is only the combination: how the three coins' drawdowns overlap.
A result here is decision support on known data, not evidence that the filter
works. It is weaker than EXPERIMENT-001 and should be read that way.

## Method

- **Window:** 2022-02-01 → 2026-09-29, the longest in which all three coins
  have a warmed 200-day average (SOL's history begins 2021-06-17). Earlier bars
  are indicator history only (`--trade-from`).
- **Data:** the same Coinbase files as EXPERIMENT-003, for all three coins, so
  prices come from the exchange the bot trades on. The first 16 hex digits of
  each file's SHA-256:
  - `btc-cb-daily.csv` `bb1536d01867f18c`
  - `eth-cb-daily.csv` `7d8193c9f51c6286`
  - `sol-cb-daily.csv` `9ccd222421e1f35a`
- **Strategy:** regime-sma200 with today's 10-ATR intraday stop, unchanged.
  `--full-exposure` per coin; 60bps taker + 5bps slippage on every fill.
- **The portfolio** (`scripts/combine-sleeves.mjs`): a third of the starting
  money in each coin's run. Each third compounds on its own and is never
  rebalanced.
- **BTC alone:** the BTC run with the whole account.

### How this differs from the live bot

The live bot sizes each entry at 33% of the whole account at that moment, so
the thirds are rebalanced a little every time a coin re-enters. The sleeves
here never rebalance. With one or two coins out of the market, both leave the
idle share in cash. The difference is second-order but real. It is stated here
rather than modelled, to keep the test simple.

## Decision rule

The portfolio is compared with BTC alone **at the same drawdown**, as in
EXPERIMENT-001:

- If the portfolio's maximum drawdown is smaller than BTC alone's, BTC alone is
  scaled down with idle cash (never rebalanced) until its drawdown matches.
- If the portfolio's drawdown is not smaller, it is compared with BTC alone at
  full size.

Verdicts:

- **Keep three coins** if the portfolio's annualized return is higher than the
  comparison's, rounded to 0.01 points.
- **BTC alone** otherwise, including a tie.

### Robustness check (also pre-registered)

The same comparison is run on the two halves of the window: 2022-02-01 →
2024-06-01 and 2024-06-01 → 2026-09-29. If the halves disagree with each other
or with the full window, the verdict is labelled **fragile**. The verdict itself
is still decided by the full window.

## What either result would mean

The configuration is the owner's decision. This experiment informs it and
changes nothing by itself.

A "BTC alone" verdict would be one more reason to make any real-money start
BTC-only. It would support setting `PRODUCTS=BTC-USD` with
`REGIME_ALLOCATION_PCT=99` in paper too.

A "keep three coins" verdict would say only that on 2022–2026, diversifying
helped the regime filter. It would not answer EXPERIMENT-005's finding that the
filter fails on most altcoins. It could still fail on ETH or SOL out of sample.

## Rules of conduct

1. The three coins × three windows are each run once, after this protocol is
   committed and pushed. No other window, weighting or rebalancing scheme is
   tried.
2. Results are appended below this line, unedited.

---

## Results

_(appended after the runs)_

The protocol was committed as `d4fbb0a` and on GitHub at 16:13:19Z on
2026-09-29. The nine runs (3 coins × 3 windows) were each done once, starting
16:13:26Z. `combine-sleeves.mjs` recomputes every single-coin figure from the
equity curve; each matched the backtester's own to the reported precision.

### Full window, 2022-02-01 → 2026-09-29 (decides the verdict)

|                               | Annualized | Max drawdown | Sharpe |
| ----------------------------- | ---------- | ------------ | ------ |
| BTC alone                     | **25.88%** | **−35.37%**  | 0.85   |
| ETH alone                     | 17.85%     | −40.60%      | 0.61   |
| SOL alone                     | 25.95%     | −62.86%      | 0.69   |
| **Three coins, a third each** | 23.44%     | −43.36%      | 0.75   |

The portfolio's drawdown was **deeper** than BTC alone's, so it is compared
with BTC alone at full size. It earned 2.45 points a year less, with 8 points
more drawdown.

### Robustness check: the two halves

| Half                    | Three coins     | BTC alone       | Result                                                                               |
| ----------------------- | --------------- | --------------- | ------------------------------------------------------------------------------------ |
| 2022-02-01 → 2024-06-01 | 67.28%, −26.95% | 60.60%, −20.33% | three coins +6.69 pts, drawdown deeper, so compared outright: **three coins better** |
| 2024-06-01 → 2026-09-29 | −7.47%, −35.58% | −1.76%, −35.37% | **BTC alone better** by 5.72 pts                                                     |

The halves disagree, so under the protocol the verdict is labelled fragile.

## Verdict

**BTC ALONE (fragile).**

Over the full window, the three-coin portfolio earned less than BTC alone and
had a deeper drawdown. The halves split: the three coins won the 2022–2024
recovery, when SOL returned 93% a year, and lost 2024–2026, when SOL lost 18% a
year.

What that says, without changing the verdict:

- **Adding ETH and SOL did not spread the risk; it added to it.** The
  portfolio's worst drawdown (−43%) was deeper than BTC alone's (−35%). The
  three coins fall together, so a third in each is closer to a leveraged bet on
  crypto than a diversified one.
- **The portfolio's outcome hinged on SOL.** SOL made the first half and broke
  the second. One coin's run decides the result, which is not a property to
  build on.
- **Together with EXPERIMENT-003 and 005, the evidence points one way:** the
  regime filter has a tested case on BTC and a weak or failed one everywhere
  else. The case for ETH and SOL rests on one half of one window.

## Reproduce

```bash
cd apps/engine
common="--granularity ONE_DAY --strategy regime --sma-period 200 --full-exposure"
for c in btc eth sol; do
  npx tsx src/backtest/run-backtest.ts $common --csv ../../data/$c-cb-daily.csv \
    --product $(echo $c | tr a-z A-Z)-USD --trade-from 2022-02-01 --to 2026-09-29 --json /tmp/full-$c.json
done
node ../../scripts/combine-sleeves.mjs --reference /tmp/full-btc.json \
  --mix /tmp/full-btc.json,/tmp/full-eth.json,/tmp/full-sol.json
# halves: --trade-from 2022-02-01 --to 2024-06-01, and --trade-from 2024-06-01 --to 2026-09-29
```
