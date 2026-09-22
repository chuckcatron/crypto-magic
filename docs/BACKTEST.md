# Backtest results — ta-ensemble-v1 on real BTC history

**Verdict: do not fund this strategy as configured.** It loses to simply holding
Bitcoin on every timeframe tested, on every measure — total return, Sharpe, and
return per unit of drawdown — and in both halves of every split. Its one virtue,
a shallower drawdown, is available more cheaply by holding less Bitcoin: a fixed
20% allocation beat it on return at the same drawdown.

Run on 2026-09-22. Reproduce everything below with the commands at the end.

## Data

Bitstamp BTC/USD one-minute bars, Jan 2012 → Jan 2025 (6,847,200 bars), from
[ff137/bitstamp-btcusd-minute-data](https://github.com/ff137/bitstamp-btcusd-minute-data),
aggregated to daily and hourly UTC bars. No missing days.

Checked two ways before trusting it:

| Landmark | Date | Expected | Dataset | Diff |
|---|---|---|---|---|
| Dec 2017 bubble peak (high) | 2017-12-17 | 19,700 | 19,666 | −0.2% |
| Dec 2018 bear bottom (close) | 2018-12-15 | 3,240 | 3,180 | −1.9% |
| COVID crash (close) | 2020-03-12 | 4,970 | 4,842 | −2.6% |
| Nov 2021 all-time high | 2021-11-10 | 69,000 | 69,000 | 0.0% |
| Nov 2022 post-FTX low | 2022-11-21 | 15,500 | 15,479 | −0.1% |
| Mar 2024 all-time high | 2024-03-14 | 73,800 | 73,794 | 0.0% |
| Dec 2024 first $100k day | 2024-12-05 | 103,900 | 103,647 | −0.2% |

And against an independent investing.com daily series: median daily-close
disagreement **0.23%** across 2,041 overlapping days (2015–2020).

## Results

All runs use retail Coinbase costs (60bps taker + 5bps slippage, both ways)
unless marked zero-cost.

**Full exposure** means every cap is lifted: fully invested when in a trade,
flat when out, on the same capital as buy-and-hold. The only difference from
holding is *when*, which is the question a timing signal has to answer. It is a
measurement mode, not a way to run the bot.

### Daily bars, Jan 2015 → Jan 2025 (10 years)

| | Strategy | Zero-cost | Buy & hold |
|---|---|---|---|
| Total return | +98% | +168% | +36,092% |
| Annualized | 7.5% | — | 86.3% |
| Max drawdown | −28.3% | — | −83.4% |
| Sharpe | 0.55 | 0.77 | 1.25 |
| Return / drawdown | 0.26 | 0.47 | 1.03 |
| Trades | 24 | 24 | — |
| Time in market | 8% | — | 100% |

Split: +73% vs +2,497% (first half), +6% vs +959% (second half). **Lost both.**

Fees cost about 70 points of return here, but even at zero cost the Sharpe is
0.77 against buy-and-hold's 1.25. **On daily bars the problem is the signal,
not the fees.** It is also far too selective: 24 trades in ten years, out of the
market 92% of the time through the largest bull runs in the asset's history.

### Hourly bars, Nov 2022 → Jan 2025

| | Strategy | Zero-cost | Buy & hold |
|---|---|---|---|
| Total return | **−86%** | +39% | +456% |
| Sharpe | −5.66 | 1.21 | 1.93 |
| Profit factor | 0.18 | 1.39 | — |
| Trades | 178 | 178 | — |
| Fees | $889 on $1,000 | $0 | — |

Split: −64% vs +128%, −62% vs +145%. **Lost both.**

The raw hourly signal does carry an edge — profit factor 1.39 at zero cost — but
178 round trips at 1.3% each turn +39% into −86%. **On hourly bars the problem
is the fees.**

### As configured ($25 position cap, $1,000 account)

The bot as you would actually run it deploys about 3% of the account into a
trade, so its total return is not comparable to buy-and-hold; look at edge per
trade instead.

| | Daily (10y) | Hourly (2y) |
|---|---|---|
| Profit factor | 2.14 | 0.21 |
| Expectancy per trade | +$0.89 | −$0.28 |
| Cost per round trip vs average winner | 10% | **101%** |

At the hourly default, **each trade's fees exceed the average winning trade.**

### The comparison that matters: holding less Bitcoin

Fixed BTC share, rest in cash (0% interest), rebalanced monthly, paying fees on
every rebalance, over the same window the daily strategy traded:

| BTC share | Annualized | Max drawdown |
|---|---|---|
| 10% | 9.2% | −14.8% |
| **20%** | **18.4%** | **−27.6%** |
| 30% | 27.7% | −38.6% |
| 100% | 86.5% | −83.4% |
| *the strategy* | *7.5%* | *−28.3%* |

**20% Bitcoin and nothing else matched the strategy's drawdown at 2.5× its
return.** 10% beat it on both. The strategy's only advantage over holding is
fully explained by holding less.

## Predictions, scored

Before running this I put three predictions on record:

| Prediction | Result |
|---|---|
| Hourly loses to buy-and-hold | ✓ badly |
| Most of the hourly gap is fees | ✓ +39% → −86% |
| Daily is "close" to buy-and-hold | **✗ wrong** — 7.5% vs 86%/yr, and a lower Sharpe even at zero cost |

## Caveats

- **Hindsight.** This decade saw Bitcoin rise ~360×; any long-only benchmark
  benefits. But the strategy had the same tailwind and still lost, and the
  fixed-allocation comparison uses the identical window.
- **Hourly covers only two years**, one mostly-bullish regime. Daily covers ten
  years and two full cycles, and is the stronger evidence.
- **One parameter set.** These are the defaults. Tuning them until the numbers
  improve on this same data would be fitting the past; any change needs testing
  on a window it was not tuned on.
- **31 early daily bars (2013–2016, all under $1,200) have an open outside their
  high/low** in the secondary dataset; the primary Bitstamp data is used for all
  results above.

## Bugs found and fixed while running this

- The CSV loader split on every comma, so it could not read investing.com
  exports (quoted fields, `"11,105.8"`, `"Aug 02, 2020"`), the most common free
  source. Replaced with an RFC 4180 parser; also strips the BOM, reads `Price`
  as close, and parses `698.62K`.
- **The backtest was not testing the live bot.** Live fetched ~254 bars, so its
  EMA-200 was still ~59% its seed value; the backtester computed it over the
  full history. Both now evaluate on the same 801-bar window. It did not change
  these results (the backtest had been using the converged indicator all
  along), but the live bot now runs the indicator that was actually tested.
- Sizing against all available cash left no room for the entry fee, so every
  fully-invested entry was refused. Now sized against cash net of the fee.
- The cost section divided by the configured position cap, printing $13 billion
  per trade in full-exposure mode. Now uses the positions actually taken.
- The report compared total returns even when the strategy deployed 3% of the
  account. It now shows capital deployed and warns when total return is not a
  fair comparison.

## Reproduce

```bash
node scripts/fetch-btc-history.mjs --granularity ONE_DAY  > data/btc-daily.csv
node scripts/fetch-btc-history.mjs --granularity ONE_HOUR --from 2022-11-01 > data/btc-hourly.csv

# daily, 10 years, timing test and split
pnpm backtest -- --csv data/btc-daily.csv --granularity ONE_DAY \
  --from 2015-01-01 --to 2025-01-07 --full-exposure --split

# same, zero cost
pnpm backtest -- --csv data/btc-daily.csv --granularity ONE_DAY \
  --from 2015-01-01 --to 2025-01-07 --full-exposure --taker-bps 0 --slippage-bps 0

# hourly
pnpm backtest -- --csv data/btc-hourly.csv --granularity ONE_HOUR \
  --to 2025-01-07 --full-exposure --split

# as configured
pnpm backtest -- --csv data/btc-daily.csv --granularity ONE_DAY \
  --from 2015-01-01 --to 2025-01-07 --equity 1000
```
