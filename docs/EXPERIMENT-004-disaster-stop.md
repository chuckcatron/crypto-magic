# Experiment 004 — Can a better disaster stop protect gains?

**Status: PRE-REGISTERED.** This protocol was written and committed before any
variant below was run. The commit history is the evidence of that order.
Nothing in this section may be edited after results exist.

## Question

The regime filter's only stop is a disaster floor 10 ATR(14) below the ENTRY
price, checked intraday, and it never moves. EXPERIMENT-003 showed what that
costs. On ETH, the position bought at $10.83 in February 2017 was still
protected only at $6.68 when ETH traded above $300. On 2017-06-21 a flash crash
printed a low of $0.10. The stop triggered and sold a coin that closed that day
at $325.41, giving back about 98% of peak equity.

Two separate things went wrong, and each has its own fix:

1. **The stop never moved up**, so it protected the purchase price and none of
   the gain. Fix: let it trail the price.
2. **It triggered on a wick** that recovered within the day. Fix: judge it on
   the daily close only.

Does either fix, or both together, make the strategy better, or at least no
worse, everywhere it has been tested?

## Variants

The entry and exit signal is unchanged in every variant: regime-sma200 on daily
bars, exactly as in EXPERIMENT-001. Only the stop changes. The 10-ATR distance
is kept, not tuned.

| Variant                      | Stop level                                                                                                                 | Checked                                                           |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| **A: baseline (live today)** | entry − 10 × ATR at entry; never moves                                                                                     | intraday, against the bar's low                                   |
| **B: trailing**              | starts at A's level, then trails the highest daily close since entry by the same percentage (10 × entry ATR ÷ entry price) | intraday, against the bar's low                                   |
| **C: close-only**            | A's level; never moves                                                                                                     | only when a daily close is at or below it; exits at the next open |
| **D: both**                  | B's trailing level                                                                                                         | C's close-only trigger                                            |

Why the trail is a percentage rather than 10 ATR in dollars: the ATR is
measured once, at entry. On a coin that rises 30×, a fixed dollar distance
becomes a 1% trail that any normal day would trigger. A percentage keeps the
same width at any price. The trail ratchets on daily closes, never on
intraday highs, which is the same rule the backtester already uses.

### Fill assumptions

An intraday stop (A and B) is a market order the moment it triggers. On an
ordinary day it fills near the stop. In a crash it does not: in the 2017 GDAX
flash crash, cascading stop orders were the crash, and many filled near the
bottom. The backtester's existing assumption, a fill at exactly the stop
price, is therefore optimistic for precisely the event that motivated this
experiment. So A and B are each run twice:

- **optimistic:** fill at the stop price (the existing assumption, used in
  EXPERIMENT-001 and 003)
- **pessimistic:** fill at the bar's low (`--stop-fill low`)

The truth lies between them. C and D exit at the next day's open, like the
regime signal itself, so they have one fill assumption.

## Data

The same files as EXPERIMENT-001 and 003. They are not in the repo; the first
16 hex digits of each file's SHA-256 identify the exact inputs.

| File                    | Source                                              | SHA-256 (first 16) |
| ----------------------- | --------------------------------------------------- | ------------------ |
| `data/btc-daily.csv`    | Bitstamp, `scripts/fetch-btc-history.mjs` (EXP-001) | `5f766395d7e37f81` |
| `data/btc-cb-daily.csv` | Coinbase, fetched 2026-09-29 (EXP-003)              | `bb1536d01867f18c` |
| `data/eth-cb-daily.csv` | Coinbase, fetched 2026-09-29 (EXP-003)              | `7d8193c9f51c6286` |
| `data/sol-cb-daily.csv` | Coinbase, fetched 2026-09-29 (EXP-003)              | `9ccd222421e1f35a` |

Before this protocol was written, the baseline (A, optimistic) was re-run on
all six windows with the new code and its defaults, and it reproduced every
published figure exactly. That confirms the new options change nothing unless
asked for. No variant, and no pessimistic-fill run, has been run.

## Windows

All six windows from EXPERIMENT-001 and 003.

| #   | Product | Window                  | Data         |
| --- | ------- | ----------------------- | ------------ |
| 1   | BTC-USD | 2015-01-01 → 2022-01-01 | btc-daily    |
| 2   | BTC-USD | 2022-01-01 → 2025-01-07 | btc-daily    |
| 3   | BTC-USD | 2025-01-07 → 2026-09-29 | btc-cb-daily |
| 4   | ETH-USD | 2017-01-01 → 2022-01-01 | eth-cb-daily |
| 5   | ETH-USD | 2022-01-01 → 2026-09-29 | eth-cb-daily |
| 6   | SOL-USD | 2022-02-01 → 2026-09-29 | sol-cb-daily |

**None of these is out of sample for this question.** The baseline's results
on all six were known when the variants were chosen, and window 4 is the reason
the experiment exists. An improvement on window 4 is expected and counts for
little. The real test is whether a variant does harm anywhere else.

## Costs

60bps taker + 5bps adverse slippage on every fill, both ways, as before.
`--full-exposure`: fully invested when in, flat when out.

## Decision rule

Each variant is compared with the baseline on each window.

- **B** is compared with A under the same fill assumption, and must meet the
  rule under both: B optimistic against A optimistic, and B pessimistic against
  A pessimistic.
- **C and D** are compared with A optimistic, the baseline's most flattering
  version.

A variant **passes** only if all of the following hold:

1. **No harm, on every window:**
   - annualized return no more than 1.0 point below the baseline's, and
   - maximum drawdown no more than 2.0 points deeper than the baseline's.
2. **A real improvement on at least two windows, at least one of them not
   window 4:**
   - annualized return at least 1.0 point higher, or
   - maximum drawdown at least 5.0 points shallower.
3. **EXPERIMENT-001 still holds:** on windows 1 and 2 the variant still beats
   the same-drawdown fixed BTC allocation on annualized return, the criterion
   the regime filter originally passed.

If more than one variant passes, the one with the highest mean change in
annualized return across all six windows is chosen (for B, under pessimistic
fills). If none passes, the stop stays as it is.

A pass does not change the bot by itself. It justifies a separate change to the
engine, reviewed on its own, to run the chosen stop in paper mode. That needs
the engine to ratchet only on daily closes for B/D, and to check the stop only
at the daily close for C/D, since today it checks every 30 seconds.

## Rules of conduct

1. Each variant × window × fill combination is run once, after this protocol is
   committed and pushed. No other stop distance, trail width or trigger is
   tried.
2. Results are appended below this line, unedited.
3. With three variants against one baseline there is room for luck. That is
   why rule 1 of the decision requires no harm on every window, not a better
   average.

---

## Results

_(appended after the runs)_
