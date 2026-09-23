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
packages/notify      alert policy + ntfy / Discord / Telegram channels
packages/insight     LLM port + Ollama, news port + CryptoPanic, review prompts
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

## Backtest results

**ta-ensemble-v1 fails.** On real BTC history it loses to buy-and-hold on every
timeframe and every measure; a fixed 20% Bitcoin allocation matched its drawdown
at 2.5× the return. See [`docs/BACKTEST.md`](docs/BACKTEST.md).

**A 200-day regime filter passes — provisionally.** Hold BTC while it closes
above its 200-day average, cash otherwise. Tested under a protocol committed
before any result existed: developed on 2015–2021, then run once on an untouched
2022–2025 holdout, where it made 52%/yr at a −30% drawdown against 30%/yr at
−67% for buy-and-hold. But the holdout pass rests mostly on sitting out 2022,
two trades carry 98% of its profit, and the sample is about three bear markets.
It has earned paper trading, not money. See
[`docs/EXPERIMENT-001-regime-filter.md`](docs/EXPERIMENT-001-regime-filter.md).

## Before you risk real money

```bash
pnpm backtest -- --product BTC-USD --days 365 --split
```

Runs the same strategy, stop logic and risk caps over real historical candles,
and leads with the only comparison that matters:

```
  STRATEGY  vs  BUY & HOLD
                          strategy     buy & hold
    Total return            -5.81%        +99.70%
    Max drawdown            -5.98%        -44.63%
    Return / drawdown        -0.50           0.94
    Time in market             13%           100%
```

Bitcoin's history is dominated by a handful of enormous up-moves. Any long-only
strategy that catches a few of them shows a big positive return and looks like
an edge. The question is whether it beat simply holding — on return, on
drawdown, or ideally both. The report states a verdict in words so the answer
cannot be skimmed past.

`--split` scores the first and second halves separately. An edge that appears in
one half and vanishes in the other is a fitted parameter, not an edge.

Useful flags:

| flag | what it does |
|---|---|
| `--csv <path>` | backtest a CSV instead of Coinbase. `node scripts/fetch-btc-history.mjs` builds one from 13 years of Bitstamp data |
| `--from` / `--to` | restrict a CSV to a date window |
| `--full-exposure` | lift every cap: fully in or fully out, on the same capital as buy-and-hold. The fair timing test |
| `--strategy regime --sma-period 200` | the 200-day regime filter instead of ta-ensemble-v1 |
| `--trade-from` | trade and score from a date, using earlier bars only as indicator history — for holdout windows |
| `--split` | first-half vs second-half, scored separately |
| `--taker-bps` / `--slippage-bps` | model a different fee tier, or set both to `0` to separate strategy performance from trading costs |
| `--days`, `--granularity`, `--equity`, `--json` | window, bar size, starting capital, dump full result |

### Trading costs are probably your binding constraint

The report ends with a cost section, and on a small account it usually matters
more than anything else in it:

```
    Round-trip cost         1.30% of position value
    Cost per round trip     $0.33 at the $25 position cap
    Versus average winner   47% of +$0.70
```

At Coinbase's retail taker tier every trade starts 1.2% behind, before slippage.
With a $25 position cap that is $0.33 a round trip against an average winner of
well under a dollar. Set `--taker-bps 0 --slippage-bps 0` to see how much of a
result is the strategy and how much is just the cost of trading — if the gap is
large, the fee tier and position size are worth more attention than any
indicator parameter.

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
that matters. Then `chmod 600 .env`.

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

## Alerting

A 24/7 bot you have to remember to check is not monitored. Configure at least
one channel before running live:

```bash
# .env — any or all; each is tried independently
NTFY_TOPIC=crypto-magic-8f3k2p9wqz          # easiest phone push; install the ntfy app
DISCORD_WEBHOOK_URL=https://discord.com/...
TELEGRAM_BOT_TOKEN=...                       # with TELEGRAM_CHAT_ID
```

Then press **Test alert** on the dashboard. An alerting setup you have never
seen fire is not an alerting setup.

What reaches you at the default `warning` threshold:

| | |
|---|---|
| 🔴 critical | kill switch engaged · trading halted · positions disagree with the exchange |
| 🟡 warning | order rejected · engine errors |
| 🔵 info | positions opened and closed, engine start/stop (set `ALERT_MIN_SEVERITY=info`) |

### Why it won't cry wolf

The failure mode of alerting is never "too few alerts" — it is a channel you
muted three weeks ago. When Coinbase was unreachable during development the
engine logged the same error every 30 seconds; unfiltered that is 120 pages an
hour.

So the same recurring condition is sent at most once per `ALERT_COOLDOWN_SECONDS`
(default 15 minutes), and the occurrences in between are counted, not lost — the
next one that goes out says how many it stands for. Numbers inside messages are
normalized before matching, so "price 61240.55 below stop" and "price 59180.20
below stop" are recognised as the same recurring condition.

**Critical alerts bypass the hourly rate limit.** A cap that can swallow "kill
switch engaged" is a bug, not a feature. They still respect the cooldown, so a
stuck critical condition cannot become a flood either.

### The heartbeat, and why silence matters

Alerts can only fire while the process is alive. If the Mac sleeps, the process
is killed or the disk fills, the bot sends nothing — and nothing is exactly what
a healthy quiet day looks like too.

So it sends a short daily check-in with equity, open positions and the last 24
hours of P&L. **If it stops arriving, that is the signal.** This only works if
you actually notice its absence; it is a weak watchdog, not a strong one. A
proper external watchdog would be better and this project does not have one.

## Trade reviews with a local model

Optional, off by default, and deliberately kept out of the trade path.

```bash
brew install ollama && ollama serve
ollama pull llama3.1:8b
# then in .env:  LLM_ENABLED=true
```

After a trade closes, a background worker hands the model the entry reasons, the
indicators, the exit reason and the real prices, and asks it to judge **process
and outcome separately**:

| | won | lost |
|---|---|---|
| **sound process** | worked | the normal cost of trend following |
| **flawed process** | got lucky — the dangerous one | at least it was cheap |

That distinction is the entire point. A 45%-win-rate strategy feels like failure
from the inside, and the instinct is to change it after a losing streak. A
review that says "you followed the rules and lost, that is what this looks like"
is worth more than one that says "you lost".

Click any trade on the dashboard to read its review.

What this is not: the model **cannot trigger, size, veto or exit a trade.** It
reads closed history and writes text. The entry path stays fully deterministic
and backtestable, and turning the model off changes nothing about how the bot
trades. If Ollama is down, wedged, or returns nonsense, you lose a paragraph.

Optionally set `NEWS_ENABLED=true` with a
[CryptoPanic](https://cryptopanic.com/developers/api/) key and the review also
sees the headlines published during the trade's window — again, as context for
the write-up afterwards, never as an input to the decision.

### Why not a cloud model, or news-driven entries?

Both were considered and rejected for this build:

- **Nothing leaves the machine.** Your positions and P&L are not interesting to
  anyone else, and a local model keeps it that way at zero marginal cost.
- **Sentiment-gated entries need a live feed to be anything but fiction.** A
  model reasoning about "market sentiment" from training data months out of date
  will confidently veto good trades and wave through bad ones. If you want this
  later, wire the feed into the entry path deliberately and backtest what you
  can — do not let it arrive by accident.

## Testing

```bash
pnpm test        # 289 tests
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
