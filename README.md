# crypto-magic

A cryptocurrency trading bot that runs 24/7 on a MacBook. Trend-following, spot
long-only, Coinbase Advanced Trade, with a Next.js dashboard.

It is built so that the interesting part — the strategy — is the part you can
change freely, because everything that can lose money in an uninteresting way
(duplicate orders, forgotten positions, runaway loops, stale prices) is handled
underneath it and covered by tests.

```
packages/core        pure domain — indicators, strategy, risk, backtester. No I/O.
packages/exchange    ExchangeAdapter port + Coinbase adapter + paper adapter
apps/engine          NestJS engine: the loop, persistence, dashboard API
apps/web             Next.js dashboard
```

## Quick start

```bash
pnpm install
cp .env.example .env          # defaults are paper mode; safe as-is
pnpm build

pnpm engine                   # terminal 1 — the bot
pnpm dashboard                # terminal 2 — http://localhost:3000
```

Paper mode needs **no API key**. It pulls real prices from Coinbase's public
endpoints and simulates the money, so you can watch it behave before it can
cost anything.

## Before you risk real money

```bash
pnpm backtest -- --product BTC-USD --days 365
```

Runs the same strategy, stop logic and risk caps over real historical candles
and prints a report — then tells you why not to trust it too much. Read that
part. Then leave it in paper mode for a few weeks and compare.

## Going live

Live mode needs **three** independent things to be true. This is deliberate:
one typo should never be able to start spending money.

1. `TRADING_MODE=live`
2. `LIVE_TRADING_ACK=I_UNDERSTAND_THIS_SPENDS_REAL_MONEY`
3. Valid `COINBASE_API_KEY_NAME` + `COINBASE_API_PRIVATE_KEY`

Create the key at [portal.cdp.coinbase.com](https://portal.cdp.coinbase.com)
with **Trade** and **View** only. Do not grant transfer or withdraw permission —
this bot never moves money off the exchange, so a key that cannot withdraw
cannot be used to drain the account.

Start with caps you would genuinely shrug at losing. The defaults are $100 total
exposure and $25 per position.

Read [`docs/SAFETY.md`](docs/SAFETY.md) first. It is short and it is the part
that matters.

## Stopping it

```bash
touch data/KILL_SWITCH     # blocks new entries; exits still run
rm data/KILL_SWITCH        # resume
```

The kill switch is a file, so it survives restarts, works when the API is
wedged, and can be set from anything that can touch a file. The dashboard has a
button for it, and a **Flatten all** button that sells everything at market.

**A halt never blocks an exit.** Being trapped in a losing position is worse
than whatever caused the halt.

## Running it 24/7

See [`docs/RUNBOOK.md`](docs/RUNBOOK.md) — launchd setup, keeping the Mac awake,
log rotation, and what to do when it misbehaves.

## The strategy

`ta-ensemble-v1` is a long-only trend follower, deliberately boring. It exists
to be a baseline that anything cleverer has to beat in the backtester first.

An **EMA(12/26) cross up** is the trigger. Four things can veto it:

| Veto | Why |
|---|---|
| price below EMA(200) | don't buy a downtrend |
| RSI > 80 | don't chase a parabolic move |
| RSI < 45 | a bullish cross this weak is a dead-cat bounce |
| ATR outside 0.15–8% | too quiet to cover fees, or too wild to stop sensibly |

Survivors get a 0–1 confidence score which **sizes** the position (0.5×–1×)
rather than gating it. Exits are the mirror cross, RSI > 88, an ATR trailing
stop, or the max holding period.

Note what is *not* here: no shorting, no leverage, no margin, no averaging down,
no scaling into a losing position. The `ExchangeAdapter` port does not expose
any of it, so a strategy bug cannot reach it.

## Position sizing

Size comes from the stop distance, not from a fixed dollar amount:

```
size = (equity × riskPerTradePct) ÷ (entry − stop)
```

A tight stop buys more coins, a wide stop fewer, so every trade loses roughly
the same amount when it is wrong. Then every hard cap is applied on top and the
smallest one wins.

## Testing

```bash
pnpm test        # 120 tests
pnpm typecheck
```

The engine's integration test boots the real Nest app against a fake exchange
and drives a full entry → stop → exit cycle. It has already caught three bugs
that would otherwise have reached live trading; they are described in the git
history.

## Honest limitations

- **One strategy, one asset class, long-only.** It makes money when crypto
  trends up and bleeds slowly when it chops sideways.
- **Backtests flatter.** Fees and adverse slippage are modelled; real fills in a
  fast market are worse. Compare against buy-and-hold before believing anything.
- **Market orders.** Fine for small size in liquid pairs, bad in thin ones. The
  slippage check catches the worst of it after the fact, not before.
- **It is not a market simulator.** Paper fills are immediate and complete.
- **No tax accounting.** Every trade is a taxable event in most jurisdictions,
  and this bot can generate a lot of them. The `trades` table has what your
  accountant needs; extracting it is on you.
