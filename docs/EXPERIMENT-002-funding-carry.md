# Experiment 002 — BTC funding-rate carry

**Status: PRE-REGISTERED.** Written and committed before any yield in this
dataset was computed. Nothing in this section may be edited after results
exist.

## The trade

Hold 1 unit of BTC spot and short 1 unit of the BTC perpetual future at the same
time. Price moves cancel: if BTC rises, the spot gains what the short loses, and
vice versa. What is left is the **funding payment**, which perpetual futures use
to stay pinned to spot: when the future trades above spot — usually, because
more traders want leveraged longs — longs pay shorts. The short leg collects it.

That is the income. It is not risk-free:

- **Funding can turn negative** and the short then *pays*. It happened in the
  May 2021 crash and through much of 2022.
- **Liquidation of the short leg.** A sharp rally makes the short lose money on
  the futures account while the matching gain sits in the spot account. Without
  enough margin, or a process to move money across, the short is closed at the
  worst moment and the hedge is gone.
- **Counterparty risk.** Both legs sit at one exchange. FTX is the reason this
  line exists.
- **Crowding.** When institutions pile into the same trade, the yield falls.

## Venue and proxy

The intended venue is Coinbase US Perpetual-Style Futures (nano BTC, 0.01 BTC
per contract; funding accrues hourly and settles twice daily in USDC; launched
2025-07-21). That is ~14 months of history — too little — and its funding
history is not reachable from this environment.

**Binance BTC-USDT perpetual funding (8-hourly) is used as the proxy.** It is
the deepest, longest-running BTC perpetual market. Coinbase US funding may be
systematically different — a less crowded, US-only market could pay more or
less — so a pass here is necessary but not sufficient: the live Coinbase funding
rate must be checked before any money moves.

Source: `supervik/historical-funding-rates-fetcher`, file
`BTC-USDT_binance_2020-01-01_2024-01-01_funding_history.csv`. Validated before
use against Bybit and Gate series from the same repository.

## Disclosure of prior knowledge

The author broadly knows funding was high in the 2021 bull market and weak or
negative in 2022 — which is exactly the development/holdout split below. As in
Experiment 001, this weakens a pass more than a fail.

## Windows

| Period | Window |
|---|---|
| **Development** | 2020-01-01 → 2022-01-01 |
| **Holdout** | 2022-01-01 → 2024-01-01 |

## Assumptions, fixed in advance

- **Capital = 1.5 × notional**: the full spot position, plus margin of 50% of
  notional in the futures account so the short survives a large rally without
  constant transfers. This is deliberately conservative; less margin would raise
  the yield and the liquidation risk together.
- **Costs**: spot leg 60bps taker + 5bps slippage per side (Coinbase retail).
  Perpetual leg 5bps per side — a typical exchange taker fee, **not a verified
  Coinbase figure**. Opening or closing the carry costs one fill on each leg.
- The small price difference between perpetual and spot at entry and exit is
  ignored; it is typically well under the fees.
- No interest is earned on the margin balance.

## Strategies

- **A — always on (primary).** Open on the first day of the window, collect
  every funding payment, positive or negative, close on the last day. No
  parameters.
- **B — conditional (secondary).** Hold the carry only while the trailing
  three-day average funding (nine payments), annualized, is at or above 10%;
  close when it falls below 0%. Every open or close pays the costs above.
  These two thresholds are fixed here and are **not** varied or tuned.

## Success criterion

A strategy **passes** a period if its **net annualized yield on capital**
(after all costs, over the full window, including time spent out of the trade)
exceeds the **approximate yield on cash** for that period — 3-month US Treasury
bills, averaged:

| Period | Approximate cash yield |
|---|---|
| Development 2020–2021 | ~0.2% |
| Holdout 2022–2023 | ~3.5% |

(Averages of ~0.4% for 2020, ~0.05% for 2021, ~2% for 2022, ~5% for 2023.
These are approximate figures from memory, not a verified series; a margin of
error of about half a point does not change the test.)

**Overall verdict for a strategy: PASS only on both periods.**

Also reported, not part of the verdict: share of payments that were negative,
the worst 30-day stretch of funding income, and the Bybit series as a
cross-exchange check.

## Rules of conduct

1. A and B are run exactly as specified, once per period.
2. The holdout is run after the development results are recorded.
3. Nothing above changes after results exist. A new idea is a new experiment.

---

## Results

*(appended after the runs)*
