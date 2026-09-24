# Running 24/7 on a MacBook

## The Mac must stay awake

A sleeping laptop does not manage stops. Pick one:

```bash
# Keep the machine awake while the engine runs (simplest; tie it to the process)
caffeinate -dimsu -w $(pgrep -f 'crypto-magic.*dist/main.js')
```

Or permanently, in **System Settings → Battery → Options**: enable *Prevent
automatic sleeping on power adapter when the display is off*. A closed lid on
battery will still sleep — keep it plugged in.

This is why the exchange-side protective stop exists. Assume the Mac will be
asleep at the worst possible moment at least once.

## Install as a launchd service

`launchd` starts the engine at login and restarts it if it dies.

```bash
./scripts/install-launchd.sh
```

That writes `~/Library/LaunchAgents/com.cryptomagic.engine.plist` pointing at
this checkout, then:

```bash
launchctl load  ~/Library/LaunchAgents/com.cryptomagic.engine.plist   # start
launchctl list | grep cryptomagic                                     # check
launchctl unload ~/Library/LaunchAgents/com.cryptomagic.engine.plist  # stop
```

Logs go to `logs/engine.log` and `logs/engine.error.log`.

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

| Alert | What to do |
|---|---|
| 🔴 Kill switch ENGAGED | Something stopped the bot from opening positions. Read the reason in the body. Exits still run. |
| 🔴 Trading halted | A breaker tripped — daily loss, losing streak, stale data, rate limit. Usually self-clearing; if it repeats daily, the caps or the strategy need attention. |
| 🔴 Reconciliation mismatch | The bot and the exchange disagree about what you hold. **Check the exchange first.** |
| 🟡 Order rejected | Often transient. Repeated rejections mean a config or balance problem. |
| 🟡 Engine error | Usually a network blip. Collapses to one alert per 15 minutes. |

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
launchctl unload ~/Library/LaunchAgents/com.cryptomagic.engine.plist
git pull && pnpm install && pnpm build && pnpm test
launchctl load ~/Library/LaunchAgents/com.cryptomagic.engine.plist
rm data/KILL_SWITCH
```

Upgrading with positions open is fine — state is in SQLite and startup
reconciles — but it is easier to reason about when you are flat.
