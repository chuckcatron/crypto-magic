# Running 24/7 on a MacBook

## The Mac must stay awake

A sleeping laptop does not manage stops. An idle Mac does not simply stay
asleep, either: it wakes briefly every 15 minutes or so, which lets the engine
look alive while it checks stops only in those wakes.

The launchd service handles this: its wrapper runs the engine under
`caffeinate`, which holds off idle sleep for exactly as long as the engine runs.
`./scripts/doctor.sh` confirms it under "Staying awake". A service installed
before this change needs `./scripts/install-launchd.sh && cm restart` once.

Running the engine in a terminal instead? Do the same by hand:

```bash
caffeinate -i -s pnpm engine
```

What nothing can prevent: a closed lid on battery sleeps. Keep it plugged in,
lid open (or on an external display).

This is why the exchange-side protective stop exists. Assume the Mac will be
asleep at the worst possible moment at least once.

## Install as a launchd service

`launchd` starts the engine and the dashboard at login and restarts either if it
dies. They are separate services, so the dashboard can never take the engine
down with it.

```bash
./scripts/install-launchd.sh
```

That writes `com.cryptomagic.engine.plist` and `com.cryptomagic.dashboard.plist`
in `~/Library/LaunchAgents`, pointing at this checkout, then:

```bash
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.cryptomagic.engine.plist      # start the engine
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.cryptomagic.dashboard.plist   # start the dashboard: http://localhost:3000
launchctl list | grep cryptomagic                                        # check
cm restart            # engine; also `cm restart dashboard` or `cm restart all`
launchctl bootout gui/$(id -u)/com.cryptomagic.engine     # stop (same for the dashboard)
```

Stop any copy running in a terminal first: the services cannot start while
ports 4000 and 3000 are taken.

Logs go to `logs/engine.log` / `logs/engine.error.log` and
`logs/dashboard.log` / `logs/dashboard.error.log`.

`KeepAlive` restarts the process if it exits. That is safe here: startup
reconciles against the exchange, and the kill switch is a file, so a restart
cannot lose a halt or duplicate a position.

## Alerting setup

Pick at least one. All three can run together; each is tried independently so
one being down does not stop the others.

**ntfy** (easiest to receive on a phone):

```bash
# Install the ntfy app on your phone, subscribe to a topic you invent, then:
NTFY_TOPIC=crypto-magic-8f3k2p9wqz
```

The topic is the only secret. Anyone who knows it can read your alerts and
anyone can publish to it, so make it long and random. Alert bodies deliberately
never contain API keys or balances.

**Discord**: Server Settings → Integrations → Webhooks → New Webhook → Copy URL
into `DISCORD_WEBHOOK_URL`.

**Telegram**: message `@BotFather`, `/newbot`, copy the token. Then message your
new bot once and read your chat id from
`https://api.telegram.org/bot<TOKEN>/getUpdates`.

Then **press Test alert on the dashboard** and confirm it arrives on your phone.
Do this before you trust it, and again after you change anything.

### What each alert means

| Alert                      | What to do                                                                                                                                                  |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 🔴 Kill switch ENGAGED     | Something stopped the bot from opening positions. Read the reason in the body. Exits still run.                                                             |
| 🔴 Trading halted          | A breaker tripped — daily loss, losing streak, stale data, rate limit. Usually self-clearing; if it repeats daily, the caps or the strategy need attention. |
| 🔴 Reconciliation mismatch | The bot and the exchange disagree about what you hold. **Check the exchange first.**                                                                        |
| 🟡 Order rejected          | Often transient. Repeated rejections mean a config or balance problem.                                                                                      |
| 🟡 Engine error            | Usually a network blip. Collapses to one alert per 15 minutes.                                                                                              |

### Tuning the noise

If you are getting too many, raise `ALERT_COOLDOWN_SECONDS` or lower
`ALERT_MAX_PER_HOUR`. If a specific condition is chattering, the dashboard's
`/api/alerts` endpoint shows exactly which fingerprints are being suppressed
and how often.

**Resist muting the channel.** That is the failure mode this design exists to
prevent; tune the thresholds instead.

### The daily check-in

Once a day at `HEARTBEAT_UTC_HOUR` you get equity, open positions and 24h P&L.
Its real purpose is the inverse: alerts can only fire while the process is
alive, so **a check-in that does not arrive is the only signal a dead bot can
send you.** Put a recurring reminder somewhere to notice it, or this does
nothing.

This is a weak watchdog. A strong one would be a second process — or another
machine — checking `/api/status` and shouting if it stops answering. Worth
adding if you ever run size that matters.

## Ollama, if you enabled trade reviews

```bash
brew install ollama
brew services start ollama      # keeps it running across reboots
ollama pull llama3.1:8b
```

Sizing: an 8B model at Q4 wants roughly 6GB of RAM while resident and writes a
review in 10-40 seconds on Apple Silicon. A 14B is noticeably better at the
process-versus-outcome distinction and wants about 10GB. Neither is on the
trade path, so latency here costs you nothing but patience.

`OLLAMA_KEEP_ALIVE` controls how long the model stays in memory between reviews.
The default of `5m` unloads it between hourly bars, which means a reload each
time; set it to `30m` if you have the RAM to spare, or `0` to unload
immediately when you need the memory back.

Reviews are fire-and-forget. If Ollama is stopped the worker notices, logs it
once and skips — trades queue up and get reviewed whenever it comes back. You
can check the backlog:

```bash
curl -s localhost:4000/api/insight | jq
```

A trade that the model fails to produce usable JSON for is retried twice and
then abandoned, so one awkward trade cannot block the queue behind it.

## Log rotation

Structured JSON logs grow. Rotate weekly:

```bash
# newsyslog.d entry — sudo tee /etc/newsyslog.d/crypto-magic.conf
# logfilename                                  mode count size when
/Users/YOU/crypto-magic/logs/engine.log        644  7     10240 *
```

## Watching it

- Dashboard: `pnpm dashboard` → http://localhost:3000
- Income planner: http://localhost:3000/planner (the **Income planner** button on the dashboard). Pure math in the browser; it works with the engine stopped.
- Live log: `tail -f logs/engine.log | npx pino-pretty`
- Quick check: `node scripts/cm.mjs` (or `curl -s localhost:4000/api/status | jq`)
- From your phone: [`REMOTE-ACCESS.md`](REMOTE-ACCESS.md)

Both the engine API and the dashboard bind to `127.0.0.1` only, and both refuse
requests from web pages (foreign `Origin`), from DNS-rebinding domains
(non-loopback `Host`), and state changes that lack the local request header.
**Do not port-forward them** — nothing here is authenticated beyond "you are on
this machine". For remote access, use Tailscale plus SSH, which keeps the
request local; see [`REMOTE-ACCESS.md`](REMOTE-ACCESS.md).

Calling a state-changing endpoint by hand needs the header:

```bash
curl -X POST localhost:4000/api/kill-switch/engage -H 'x-crypto-magic-request: 1'
curl -X POST localhost:4000/api/alerts/test        -H 'x-crypto-magic-request: 1'
```

Reads need nothing extra. The `touch data/KILL_SWITCH` route needs nothing at
all, which is why it is the one to remember.

## Routine checks

**Daily (30 seconds).** Glance at the dashboard: is equity where you expect, are
open positions the ones you expect, has anything halted?

**Weekly.** Read the trades it took and check the reasons make sense. Confirm
the machine hasn't been sleeping. Check disk space.

**Monthly.** Back up `data/crypto-magic.db` — it is your only trade record.
Compare realized results against the backtest. If they diverge badly, the
backtest was optimistic; trust the live numbers.

```bash
# Safe hot backup (do not just cp a live SQLite file)
sqlite3 data/crypto-magic.db ".backup 'backups/$(date +%F).db'"
```

## Troubleshooting

**"Entries halted: stale_market_data"** — the engine has not seen a closed bar
in `MAX_MARKET_DATA_AGE_BARS` intervals. Usually Wi-Fi. It resumes on its own.

**"Entries halted: kill_switch"** — something engaged it. Check the engine log
for the reason before releasing it; it may have been a slippage breach or a
failed reconciliation, both of which mean look at the exchange first.

**"Entries halted: daily_loss_limit"** — working as designed. Resets at UTC
midnight. If it trips often, your caps are too tight or the strategy is not
working; either way, find out which before raising the limit.

**No trades for days** — normal. A trend follower with a trend filter sits out
most of the time. Check the log for `HOLD` decisions and their reasons; the
engine records why it declined.

**Position on the exchange the bot doesn't know about** — reconciliation logs it
and refuses to manage it. Sell it yourself, or stop the bot and delete the
stale row from the `positions` table.

**Engine won't start** — config errors print every problem at once. Read the
whole list.

**Alerts stopped arriving** — check the dashboard header. `⚠ alerts failing`
means the last one reached no channel; `🔕 no alerts` means none are configured.
`curl -s localhost:4000/api/alerts | jq` shows the last ten deliveries with the
per-channel error. If the dashboard itself is unreachable, the engine is down —
which is what the missing daily check-in was telling you.

**Reviews are not appearing** — check `curl -s localhost:4000/api/insight`. A
null `model` means `LLM_ENABLED` is off; a `lastError` mentioning availability
means Ollama is not running or the model in `.env` is not pulled. Note that the
worker checks the model is actually pulled, not just that Ollama is up, because
an unpulled model turns the first review into a multi-gigabyte download.

## Upgrading

```bash
touch data/KILL_SWITCH                 # stop opening new positions
# wait for open positions to close, or flatten from the dashboard
launchctl bootout gui/$(id -u)/com.cryptomagic.engine
git pull && pnpm install && pnpm build && pnpm test
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.cryptomagic.engine.plist
cm restart dashboard                   # serve the new dashboard build
rm data/KILL_SWITCH
```

Upgrading with positions open is fine — state is in SQLite and startup
reconciles — but it is easier to reason about when you are flat.

## Trading more than one coin

List every coin to trade in `PRODUCTS`, and give each a share of the account
with `REGIME_ALLOCATION_PCT`. Each buy is that percentage of equity at the time,
so for three coins use 33, not 100: at 100 the first coin to signal takes all
the cash, and the rest buy whatever is left over.

```bash
PRODUCTS=BTC-USD,ETH-USD,SOL-USD
REGIME_ALLOCATION_PCT=33
MAX_OPEN_POSITIONS=4            # at least the number of coins
MAX_TOTAL_NOTIONAL=1000         # covers the whole account
MAX_POSITION_NOTIONAL=1000
```

Read `docs/EXPERIMENT-003-regime-filter-eth-sol.md` first: the rule was
backtested on each coin, and did not pass on all of them.

Changing the split does not resize positions already open. Either flatten and
let the engine re-enter at the next daily close, or start a fresh paper account.

To see a coin's price without trading it, add it to `WATCH_PRODUCTS` instead.
Its dashboard tile says "watching, not traded".

## Starting a fresh paper account

Archives the database (positions, trades, equity history, events) and starts
again from `PAPER_STARTING_CASH`. Nothing is deleted, and it costs nothing:
paper positions are not sold, they are just left in the archive.

```bash
launchctl bootout gui/$(id -u)/com.cryptomagic.engine    # stop it; launchd will not restart it
mkdir -p data/archive-$(date +%F)
mv data/crypto-magic.db* data/archive-$(date +%F)/       # the .db and its -wal/-shm, together
ls data/KILL_SWITCH 2>/dev/null && cm release --offline  # a leftover kill switch blocks every entry
# edit .env now if the products or split are changing
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.cryptomagic.engine.plist
cm restart dashboard
cm events                                                # engine started, then any entries
```

On its first check the engine evaluates the latest closed daily bar for every
coin, so each one above its 200-day average is bought straight away, not at the
next close. The archived database opens read-only with
`sqlite3 -readonly data/archive-<date>/crypto-magic.db`.

## Changing Node versions

The engine has one compiled dependency, `better-sqlite3`, and it only loads
under the Node version it was built for. The launchd services also record which
`node` to run when they are installed. So after `brew install`/`brew upgrade`
touches Node, or you switch versions, do all three, in this order, from a shell
where `node -v` shows the version you want:

```bash
(cd "$(node -p "require('path').dirname(require.resolve('better-sqlite3/package.json',{paths:['apps/engine']}))")" && rm -rf build && npm run install)
./scripts/install-launchd.sh           # the services now run this node
cm restart all
./scripts/doctor.sh                    # "Database module loads" for the shell and the service
```

Symptoms of skipping a step: `cm restart` says "not answering after 30s", and
`logs/engine.error.log` shows `NODE_MODULE_VERSION` (step 1) or
`dyld: Library not loaded` (Homebrew removed a library the old node needed:
step 2).
