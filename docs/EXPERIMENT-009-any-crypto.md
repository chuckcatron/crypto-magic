# Experiment 009 — Which "trade any crypto" bot works?

**Status: PRE-REGISTERED.** This protocol was written and committed before any
data below was fetched and before any rule was run. The commit history is the
evidence of that order. Nothing in this section may be edited after results
exist.

## Question

The owner's friend reports +200% over five months with a bot that "trades any
crypto". His rules are not known. Four kinds of bot could produce results like
that:

- **momentum rotation**: hold whatever has risen most lately;
- **breakout trend following**: buy any coin making new highs;
- **volume-surge chasing**: buy breakouts on unusual volume, the "hype" coins;
- **dip buying**: buy sharp drops in coins that are trending up.

Each is tested here as a fixed long-only rule on daily bars, with
conventional textbook parameters and realistic costs. Two of them are also
tested behind the one gate this repo has seen pass, the 200-day regime filter
on BTC.

The question: **does any of them beat simply holding Bitcoin at the same
drawdown, out of sample, on a universe that includes the coins that died?**

EXPERIMENT-008 showed that fast trading has no edge here. Every rule in this
experiment holds for days to weeks.

## Universes

### B, primary: Binance spot, survivors and casualties alike

Every USDT pair in Binance's public data archive (`data.binance.vision`,
`data/spot/monthly/klines/<SYMBOL>/1d/`), as listed on 2026-10-06: 757 pairs.
**It includes pairs Binance has since delisted**, such as LUNA and FTT, with
their collapses. A rule that bought a coin on its way to zero pays for it
here. That is the reason for using this venue. Prices in USDT are treated as
USD.

Excluded before anything runs, 168 pairs in three frozen groups (Appendix A):

1. Stablecoins, fiat, gold, and wrapped or staked tokens (31).
2. Leveraged tokens (50). These are a base asset that is another listed base
   plus UP, DOWN, BULL or BEAR, and BULL and BEAR themselves.
3. Tokenized stocks (87). These are every base asset ending in B whose first
   month in the archive is 2026-06 or later. They are the equity batch Binance
   listed from June 2026.

That leaves 589 pairs.

### C, secondary: Coinbase USD spot, today's listing

The 404 USD spot products Coinbase's public API lists on 2026-10-06, 400
online and 4 delisted. Excluded: DAI, PAX, USD1, USDS, USDT (stablecoins),
PAXG (gold), CBETH, LSETH, MSOL, JITOSOL (staked), and WAXL (a wrapped
duplicate of AXL). That leaves 393.

**C is survivorship-biased:** coins Coinbase delisted are missing. It is used
only for criterion 5, to check that a rule which works on B also works on the
exchange the owner uses.

### Point-in-time universe

At each daily close, a coin is **in the universe** only if:

- it has at least 60 daily bars up to and including that day, and a bar that
  day; and
- it is among the 50 coins with the highest average dollar volume (volume ×
  close) over the 30 days ending that day.

Only past volume is used. A coin enters the universe as it becomes liquid,
not because it later became famous.

## Costs (fixed in advance)

| Case                    | Each fill, entry or exit                                    |
| ----------------------- | ----------------------------------------------------------- |
| **Base**                | 65 bps: the repo's Coinbase spot model, 60 fee + 5 slippage |
| **Stress**, criterion 4 | 130 bps                                                     |
| Reported only           | 15 bps: a low-fee venue, or resting maker orders            |

Spot, so no funding. Long only, with no leverage, margin or shorting.

## Portfolio mechanics, the same for every strategy

- Decisions are made at the daily close (00:00 UTC) from closed bars. They fill
  at the next day's open and pay the fill cost. Sells fill before buys.
- Equity is split into **slots**: 5 for S1 and S1R, 10 for the rest. A new
  position takes one slot, 1/slots of equity at the decision. A buy is cut
  back to the cash available at the fill. Nothing is ever bought on margin.
- When more coins qualify than there are free slots, the strongest by 28-day
  return are taken first. S4 instead takes the lowest RSI(2) first. Ties go by
  symbol.
- **A held coin that has no bar on a day is closed at its last close,** paying
  the cost. This is how a delisting is booked: the coin was sold at its last
  traded price. A buy for a coin with no bar at the fill is cancelled.
- With fewer qualifying coins than slots, the rest stays in cash.
- Exits apply to every held coin, whether or not it is still in the universe.
  Entries come only from the universe.
- No stop-losses beyond each strategy's own exit. Each archetype is tested as
  it is usually run. Drawdowns are reported, and criterion 1 already prices
  them in.

### Indicators

All indicators use daily closes and fixed trailing windows:

- the N-day high or low: the highest or lowest close of the previous N days,
  excluding today;
- SMA(N);
- the 28-day return: close ÷ the close 28 days earlier;
- RSI(2): the repo's Wilder RSI from `packages/core`, over the trailing 100
  closes.

## The strategies

| ID      | Archetype         | Rule                                                                                                                                                                      |
| ------- | ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **S1**  | Momentum rotation | Every Sunday close, rank the universe by 28-day return and hold the top 5, 20% each. Fills at Monday's open: drop the coins that left, then resize everything to 20%      |
| **S1R** | Same, gated       | S1, but whenever the venue's BTC closes below its 200-day SMA, sell everything at the next open. Rotate again at the first Sunday close with BTC above it                 |
| **S2**  | Breakout          | Buy when the close is above the 20-day high. Sell when the close is below the 10-day low. These are the classic Turtle System 1 lengths                                   |
| **S2R** | Same, gated       | S2, plus: no entries while BTC is below its 200-day SMA, and everything is sold at the next open when it closes below                                                     |
| **S3**  | Volume surge      | Buy when the close is above the 20-day high and the day's dollar volume is at least 3× its average over the previous 30 days. Sell when the close is below the 10-day low |
| **S4**  | Dip buying        | Buy when RSI(2) < 10 and the close is above the coin's own 200-day SMA. Sell when the close is above the 5-day SMA. This is Connors's RSI(2) rule                         |

The venue's BTC is BTCUSDT for B and BTC-USD for C.

**Benchmarks**, reported but not part of the verdict:

- holding BTC;
- holding the point-in-time top 50 in equal weight, rebalanced at each month's
  first open, paying costs;
- the BTC 200-day regime filter: hold BTC above the SMA, cash below, without
  EXPERIMENT-001's disaster stop.

## Windows

| Window      | Trading                 |
| ----------- | ----------------------- |
| Development | 2019-01-01 → 2023-07-01 |
| Holdout     | 2023-07-01 → 2026-10-01 |

Earlier bars are used only for indicators and the universe ranking. Each
window starts in cash.

Also reported, not part of the verdict: each strategy's return over
**2026-05-06 → 2026-10-01**, Muggli's live period, taken from the holdout run.

## Scoring: the yardstick from EXPERIMENT-001

For each strategy, universe and window: daily equity at each close,
annualized return (compounded, over 365 days), maximum drawdown at daily
closes, trades and time in market.

The yardstick is **the same-drawdown BTC allocation**:

- a fixed fraction of equity in the venue's BTC, with the rest in cash at 0%;
- rebalanced at each month's first open, paying the same base cost;
- the fraction chosen so its maximum drawdown over the window equals the
  strategy's.

A strategy **beats the yardstick** if its annualized return is higher. If its
drawdown is deeper than holding BTC outright, it must beat holding BTC
outright. This asks whether the strategy did better than simply holding less,
or more, Bitcoin at the same pain.

## Decision rule

A strategy **passes** only if all five hold:

1. **B, development:** beats the yardstick.
2. **B, holdout:** beats the yardstick.
3. **B, holdout:** a positive return in each half, 2023-07-01 → 2025-02-15 and
   2025-02-15 → 2026-10-01.
4. **B, holdout, stress costs:** annualized return > 0.
5. **C, holdout:** beats the yardstick on Coinbase's listing.

Six strategies are tested. With that many, one of them can pass by luck, so a
single pass would earn paper trading, not money.

## What a pass would and would not mean

A strategy that passes has earned forward paper trading on the venue where it
passed. On Coinbase spot that means a multi-coin long-only paper engine, which
does not exist yet. Real money also needs:

- weeks of paper results that match;
- stops sized to the owner's risk rules;
- the owner's decision.

If nothing passes, nothing changes. The regime filter on BTC stays the only
tested rule, and Muggli's +200% stays unexplained by any of these archetypes.

## Disclosure of prior knowledge

Before writing this, the author had seen:

- BTC's daily history for 2015–2026, and the daily history of the 23 coins
  that have perpetual futures, through EXPERIMENT-001 to EXPERIMENT-008.
- **EXPERIMENT-008's F4**, a weekly long-short momentum rotation across 23
  coins. Its long leg made money in both of these windows. S1 is a relative of
  that long leg, on different universes and parameters. This weakens a pass by
  S1 or S1R more than any other.
- EXPERIMENT-005: the 200-day filter on 27 Coinbase altcoins mostly lost to
  holding a fixed share of the same coin.
- What the top 96 Coinbase coins returned when held over 2026-05-06 →
  2026-10-05.
- Metadata only: Binance's symbol list, the first and last archive month of
  the assets ending in B, and four rows of LUNA's May 2022 file, read to check
  the format.

No rule here has been run on any data. The archetypes were chosen to mirror
the kinds of bot that could produce Muggli's claim. The parameters are
textbook values, not choices made from this data: 20 and 10 days for Turtle,
RSI(2) under 10 above the 200-day SMA for Connors, and 4-week momentum held in
a top 5.

## Data, fetched after this protocol is pushed

- B: `scripts/fetch-binance-daily.mjs` downloads every monthly 1-day file for
  the 757 pairs through 2026-09, through the archive's S3 endpoint, and writes
  `data/binance-daily/<SYMBOL>.csv` in the repo's candle format. The archive
  switched its timestamps from milliseconds to microseconds in 2025, and both
  are read as seconds.
- C: `scripts/fetch-coinbase-history.mjs` writes one daily file per product to
  `data/coinbase-daily/`.
- A manifest records each file's rows, first and last date, and SHA-256.

## Rules of conduct

1. The code implements exactly these rules. Where it must decide something
   this text leaves open, it takes the conservative choice, and the process
   notes say so.
2. Development runs first. Its results are committed before the holdout runs,
   and the holdout runs for every strategy.
3. Each strategy runs once per universe, window and cost case. A re-run is
   allowed only for a bug that does not change the rules, and the notes say
   why.
4. No change to strategies, universes, costs, windows or criteria after a
   holdout result has been seen. A new idea is a new experiment.
5. Results are appended below this line, unedited.

## Appendix A — Binance exclusions (frozen 2026-10-06)

**Stablecoins, fiat, gold, wrapped or staked (31):** AEUR, AUD, BETH, BFUSD,
BKRW, BNSOL, BUSD, DAI, EUR, EURI, FDUSD, FRAX, GBP, PAX, PAXG, RLUSD, SUSD,
TUSD, USD1, USDC, USDE, USDP, USDS, USDSB, USDSOLD, UST, USTC, WBETH, WBTC,
XAUT, XUSD.

**Leveraged tokens (50):** 1INCHDOWN, 1INCHUP, AAVEDOWN, AAVEUP, ADADOWN,
ADAUP, BCHDOWN, BCHUP, BEAR, BNBBEAR, BNBBULL, BNBDOWN, BNBUP, BTCDOWN, BTCUP,
BULL, DOTDOWN, DOTUP, EOSBEAR, EOSBULL, EOSDOWN, EOSUP, ETHBEAR, ETHBULL,
ETHDOWN, ETHUP, FILDOWN, FILUP, LINKDOWN, LINKUP, LTCDOWN, LTCUP, SUSHIDOWN,
SUSHIUP, SXPDOWN, SXPUP, TRXDOWN, TRXUP, UNIDOWN, UNIUP, XLMDOWN, XLMUP,
XRPBEAR, XRPBULL, XRPDOWN, XRPUP, XTZDOWN, XTZUP, YFIDOWN, YFIUP.

**Tokenized stocks (87):** AAOIB, AAPLB, ADBEB, AGPUB, ALABB, AMATB, AMCB,
AMDB, AMZNB, ARMB, ASMLB, ASTSB, AVGOB, AXTIB, BABAB, BEB, BMNRB, BNCB, CBRSB,
COHRB, COINB, CRCLB, CRDOB, CRMB, CRWDB, CRWVB, CYPHB, DELLB, DJTB, DRAMB,
EWYB, FLNCB, FWDIB, GLWB, GMEB, GOOGLB, GPROB, GSB, HIMSB, HOODB, HPEB, IBMB,
INTCB, INTWB, IRENB, KORUB, LITEB, METAB, MRNAB, MRVLB, MSFTB, MSTRB, MUB,
MUUB, MVLLB, NBISB, NFLXB, NOKB, NVDAB, ORCLB, PDDB, PLTRB, PYPLB, QCOMB,
QNTB, QQQB, RDDTB, RKLBB, SHAZB, SKHYB, SMCIB, SMHB, SNDKB, SNXXB, SOXLB,
SOXSB, SPCXB, SPYB, SQQQB, STXB, TQQQB, TSLAB, TSMB, USARB, WDCB, WENB, ZMB.

---

## Results

_(appended after the runs)_

The protocol was committed as `347c855` at 17:12:22Z on 2026-10-06 and pushed
at once. The data was fetched after that, and the simulation code was
committed as `a0384c6` before any run.

### Data

- **B:** all 757 USDT pairs, every monthly file checked against Binance's
  published SHA-256, through 2026-09. The manifest is
  `data/binance-daily/manifest.json` (SHA-256 `7274e6af7c962f63…`), with each
  pair's rows, dates and CSV hash. Examples: BTCUSDT 3,332 days from
  2017-08-17 (`61d1919a8db698ee…`), LUNAUSDT 2,215 days (`193cc6b697d2c8c1…`).
- **C:** all 404 Coinbase USD products, with no fetch failures.

Inventory (descriptive, `pnpm --filter @crypto-magic/futures inventory-009`):

| Universe | Kept | Stopped trading before 2026-09-30 | Gaps over 7 days |
| -------- | ---- | --------------------------------- | ---------------- |
| B        | 589  | **191**                           | 8                |
| C        | 393  | 3                                 | 1                |

A third of B's coins died or were delisted. That is the survivorship this
test was built to include. C has almost none of them.

B's gaps are delistings and relistings under the same ticker, and token
swaps: LUNA (Terra 2.0 took the ticker after the May 2022 collapse), FTT
(halted November 2022, resumed September 2023), VEN→VET (2018), STRAX (a 10×
redenomination, 2024), VIDT, CVC, KEY and NBT. The pre-registered rule
handles all of them the same way: a held coin is sold at its last close
before the gap.

### Development, 2019-01-01 → 2023-07-01 (recorded before the holdout was run)

Run once at 17:25:18Z.

**Universe B**, base costs (65 bps a fill), with the stress and low-fee
returns alongside:

| Strategy               | Annualized  | Total        | Max drawdown | Trades | Invested | Same-drawdown BTC | Beats it? | At 130 bps | At 15 bps |
| ---------------------- | ----------- | ------------ | ------------ | ------ | -------- | ----------------- | --------- | ---------- | --------- |
| S1 momentum rotation   | −36.22%     | −86.78%      | −98.25%      | 508    | 100%     | 100% BTC: +59.32% | no        | −53.06%    | −19.16%   |
| S1R gated rotation     | −15.12%     | −52.16%      | −86.20%      | 299    | 52%      | 100% BTC: +59.32% | no        | −29.00%    | −2.54%    |
| S2 breakout            | +26.45%     | +187.42%     | −94.98%      | 664    | 69%      | 100% BTC: +59.32% | no        | +6.93%     | +43.59%   |
| **S2R gated breakout** | **+61.16%** | **+755.79%** | **−64.36%**  | 449    | 42%      | 74% BTC: +47.81%  | **yes**   | +43.60%    | +76.14%   |
| S3 volume surge        | +25.23%     | +175.09%     | −86.68%      | 486    | 54%      | 100% BTC: +59.32% | no        | +9.82%     | +38.74%   |
| S4 dip buying          | −25.26%     | −73.02%      | −76.61%      | 970    | 25%      | 100% BTC: +59.30% | no        | −43.67%    | −7.23%    |
| _Hold BTC_             | +59.32%     | +712.66%     | −76.63%      | 1      | 100%     |                   |           |            |           |
| _Top 50, equal weight_ | +16.28%     | +97.12%      | −91.54%      | 493    | 100%     |                   |           |            |           |
| _BTC 200-day filter_   | +39.05%     | +340.56%     | −67.60%      | 15     | 55%      | 80% BTC: +50.83%  | no        |            |           |

**Universe C** (Coinbase), base costs:

| Strategy               | Annualized | Total    | Max drawdown | Trades | Invested | Same-drawdown BTC | Beats it? |
| ---------------------- | ---------- | -------- | ------------ | ------ | -------- | ----------------- | --------- |
| S1 momentum rotation   | −33.48%    | −84.02%  | −98.65%      | 435    | 100%     | 100% BTC: +59.40% | no        |
| S1R gated rotation     | +2.77%     | +13.06%  | −80.42%      | 251    | 52%      | 100% BTC: +59.40% | no        |
| S2 breakout            | −9.77%     | −37.01%  | −94.90%      | 524    | 54%      | 100% BTC: +59.40% | no        |
| S2R gated breakout     | +4.86%     | +23.79%  | −79.78%      | 365    | 33%      | 100% BTC: +59.40% | no        |
| S3 volume surge        | +1.72%     | +7.96%   | −86.34%      | 333    | 37%      | 100% BTC: +59.40% | no        |
| S4 dip buying          | −17.91%    | −58.85%  | −60.94%      | 477    | 13%      | 68% BTC: +44.66%  | no        |
| _Hold BTC_             | +59.40%    | +714.58% | −76.67%      | 1      | 100%     |                   |           |
| _Top 50, equal weight_ | +21.07%    | +136.31% | −90.58%      | 181    | 100%     |                   |           |
| _BTC 200-day filter_   | +37.98%    | +325.53% | −67.64%      | 16     | 55%      | 80% BTC: +50.89%  | no        |

Noted without adjusting anything:

- **Only S2R beat the yardstick on B.** It made +61% a year against +48% for
  the 74% BTC allocation with the same drawdown.
- **On C it did not:** +4.9% a year. In 2019–2020, C's universe held only a
  dozen or so coins. Criterion 5 tests C on the holdout only.
- **S1, the momentum rotation, is the "Muggli" profile in full.** A
  verification pass on its trades showed equity grew 3.4× by the end of 2021,
  from $10,000 to $34,181. It then fell to $1,380 in 2022, a 96% loss in one
  year, as concentrated top-5 bets ran into LUNA, FTX and the bear market.
  Rotating weekly at 65 bps a fill also costs about 1% a week in fees, and
  even at 15 bps it lost 19% a year.
- **Dip buying (S4) lost in every cost case.**
- **Holding the top 50 equally** did far worse than holding BTC, at a deeper
  drawdown.
- The BTC 200-day filter, the strategy now in paper trading, also trailed its
  yardstick in this window. EXPERIMENT-001's development window was
  2015–2021.

### Holdout, 2023-07-01 → 2026-10-01 (run once, nothing changed)

Run once at 17:26:47Z, after the development results were on GitHub
(`06e2874`, pushed 17:26:32Z).

**Universe B**, base costs, with the stress and low-fee returns alongside:

| Strategy               | Annualized | Total    | Max drawdown | Trades | Invested | Same-drawdown BTC | Beats it? | At 130 bps | At 15 bps |
| ---------------------- | ---------- | -------- | ------------ | ------ | -------- | ----------------- | --------- | ---------- | --------- |
| S1 momentum rotation   | −84.08%    | −99.75%  | −99.80%      | 394    | 100%     | 100% BTC: +35.82% | no        | −88.57%    | −79.42%   |
| S1R gated rotation     | −67.61%    | −97.45%  | −97.98%      | 272    | 58%      | 100% BTC: +35.82% | no        | −74.15%    | −61.44%   |
| S2 breakout            | −51.73%    | −90.66%  | −95.47%      | 567    | 73%      | 100% BTC: +35.82% | no        | −62.24%    | −42.96%   |
| S2R gated breakout     | −31.36%    | −70.61%  | −85.99%      | 409    | 46%      | 100% BTC: +35.82% | no        | −41.23%    | −22.60%   |
| S3 volume surge        | −27.63%    | −65.09%  | −84.45%      | 356    | 52%      | 100% BTC: +35.82% | no        | −36.89%    | −19.06%   |
| S4 dip buying          | −27.24%    | −64.48%  | −72.80%      | 804    | 28%      | 100% BTC: +35.82% | no        | −47.34%    | −6.82%    |
| _Hold BTC_             | +35.82%    | +170.88% | −52.97%      | 1      | 100%     |                   |           |            |           |
| _Top 50, equal weight_ | −32.10%    | −71.64%  | −91.44%      | 475    | 100%     |                   |           |            |           |
| _BTC 200-day filter_   | +22.04%    | +91.22%  | −35.22%      | 17     | 61%      | 60% BTC: +22.95%  | no        |            |           |

**Universe C** (Coinbase), base costs:

| Strategy               | Annualized | Total    | Max drawdown | Trades | Invested | Same-drawdown BTC | Beats it? |
| ---------------------- | ---------- | -------- | ------------ | ------ | -------- | ----------------- | --------- |
| S1 momentum rotation   | −80.23%    | −99.49%  | −99.73%      | 391    | 100%     | 100% BTC: +35.79% | no        |
| S1R gated rotation     | −63.95%    | −96.39%  | −97.71%      | 278    | 58%      | 100% BTC: +35.79% | no        |
| S2 breakout            | −42.20%    | −83.21%  | −94.88%      | 565    | 72%      | 100% BTC: +35.79% | no        |
| S2R gated breakout     | −14.14%    | −39.13%  | −80.34%      | 408    | 46%      | 100% BTC: +35.79% | no        |
| S3 volume surge        | −22.95%    | −57.21%  | −82.77%      | 382    | 54%      | 100% BTC: +35.79% | no        |
| S4 dip buying          | −14.93%    | −40.91%  | −60.74%      | 738    | 26%      | 100% BTC: +35.79% | no        |
| _Hold BTC_             | +35.79%    | +170.71% | −53.08%      | 1      | 100%     |                   |           |
| _Top 50, equal weight_ | −17.99%    | −47.57%  | −88.76%      | 366    | 100%     |                   |           |
| _BTC 200-day filter_   | +21.83%    | +90.14%  | −35.37%      | 17     | 61%      | 60% BTC: +23.00%  | no        |

**Holdout halves, and Muggli's five months** (2026-05-06 → 2026-10-01, from
the same runs), base costs, total return:

| Strategy               | B: first half | B: second half | B: Muggli's 5 months | C: Muggli's 5 months |
| ---------------------- | ------------- | -------------- | -------------------- | -------------------- |
| S1 momentum rotation   | −70.58%       | −99.14%        | −85.55%              | −54.14%              |
| S1R gated rotation     | −81.75%       | −86.04%        | −25.48%              | −6.12%               |
| S2 breakout            | −49.89%       | −81.36%        | −10.44%              | −15.50%              |
| S2R gated breakout     | −57.54%       | −30.78%        | **+43.09%**          | **+53.10%**          |
| S3 volume surge        | −0.17%        | −65.03%        | −21.53%              | −15.86%              |
| S4 dip buying          | −46.10%       | −34.09%        | −25.77%              | −20.58%              |
| _Hold BTC_             | +217.90%      | −14.79%        | +2.69%               | +2.60%               |
| _Top 50, equal weight_ | +7.46%        | −73.61%        | −4.03%               | +20.04%              |
| _BTC 200-day filter_   | +121.46%      | −13.66%        | +19.05%              | +19.01%              |

### Applying the decision rule

| Criterion                     | S1       | S1R      | S2       | S2R                       | S3       | S4       |
| ----------------------------- | -------- | -------- | -------- | ------------------------- | -------- | -------- |
| 1. B development beats it     | **FAIL** | **FAIL** | **FAIL** | PASS +61.2% vs +47.8%     | **FAIL** | **FAIL** |
| 2. B holdout beats it         | **FAIL** | **FAIL** | **FAIL** | **FAIL** −31.4% vs +35.8% | **FAIL** | **FAIL** |
| 3. B holdout > 0 in each half | **FAIL** | **FAIL** | **FAIL** | **FAIL**                  | **FAIL** | **FAIL** |
| 4. B holdout > 0 at 130 bps   | **FAIL** | **FAIL** | **FAIL** | **FAIL**                  | **FAIL** | **FAIL** |
| 5. C holdout beats it         | **FAIL** | **FAIL** | **FAIL** | **FAIL**                  | **FAIL** | **FAIL** |
| **Verdict**                   | **FAIL** | **FAIL** | **FAIL** | **FAIL**                  | **FAIL** | **FAIL** |

## Verdict

**All six fail.** No "trade any crypto" rule here beat holding Bitcoin. Over
the holdout, every one of them lost money, on both venues and at every cost,
including 15 bps. Nothing changes: the BTC 200-day filter stays the only
tested rule.

## What this means

None of this changes the verdict.

1. **2023–2026 punished breadth.** BTC made +171% in the holdout while the
   top 50 coins, held equally, lost 72%. Every rule here spends most of its
   time in altcoins, so each one was swimming against that.
2. **These bots look brilliant in the right months, then give it back.** The
   momentum rotation grew $10,000 to $34,181 by the end of 2021 (development),
   then fell to $1,380 in 2022. In the holdout, its equity ended each year at
   $7,361 (2023), $4,775 (2024), $406 (2025) and $25 (September 2026). Its
   trades won 26% of the time, at −5.7% on average. It kept buying coins at
   the top of their pumps.
3. **Muggli's five months are exactly the kind of months that flatter one of
   these.** Over 2026-05-06 → 2026-10-01, S2R, the gated breakout, made +43%
   on Binance and +53% on Coinbase while BTC made +3%. The same rule lost 57%
   in 2024 and 58% in 2025.
   - A breakout-style bot on altcoins, concentrated or leveraged, turning +43%
     into +200% over those five months is entirely consistent with these
     results.
   - So is a long run of losses before or after.
   - Five strong months are not evidence of a rule that lasts. Seven years on
     a universe that includes the coins that died are.
4. **Where we perform best is still the slow, BTC-only rule.** Over the
   holdout, the BTC 200-day filter made +22.0% a year at a −35% drawdown. It
   missed its yardstick by 0.9 points a year: the 60% BTC holding with the
   same drawdown made +23.0%. That is a near-tie, not a pass. It is also the
   strategy in paper trading now. Nothing faster or broader came close.

## Process notes

- Each universe, window and cost case ran once. Nothing was re-run for a
  different result. After each window, a separate verification pass rebuilt
  S1's and S2R's runs (deterministic, identical numbers) to read their trades
  and yearly equity. Those figures are the ones quoted above.
- Data checks in the holdout: only two one-day moves beyond ×5 or ÷5 among
  universe members, OM on 2025-04-13 (×0.16) and DEXE on 2026-07-21 (×0.18).
  Both are real crashes, not data errors. Tickers relisted after a gap, and
  token swaps, are handled by the delisting rule (listed under "Data" above).
- The development note says C held "a dozen or so coins" in 2019–2020. The
  inventory shows 13 coins with Coinbase history by the end of 2019, and 30
  by the end of 2020.
- Implementation choices the protocol left open:
  - The first decision is made at the close of the day before each window, so
    every rule can be invested from the first open. The window still starts
    in cash.
  - A coin's 28-day return needs a bar exactly 28 days earlier. A coin
    without one is not ranked.
  - S1's weekly resize trades every difference, however small, as the
    protocol says.
  - In S1R and S2R, BTC without 200 days of history counts as below the gate.
    This never happens in either window.
- Run time: about 7 seconds per window for all 36 runs.
- Commands:

```bash
node scripts/fetch-binance-daily.mjs --through 2026-09            # B
node scripts/fetch-coinbase-history.mjs --product <ID> --to 2026-10-01 > data/coinbase-daily/<ID>.csv   # each C product
pnpm --filter @crypto-magic/futures inventory-009
pnpm --filter @crypto-magic/futures experiment-009 --window dev
pnpm --filter @crypto-magic/futures experiment-009 --window holdout
```
