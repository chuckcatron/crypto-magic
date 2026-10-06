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
