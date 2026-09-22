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
- Quick check: `curl -s localhost:4000/api/status | jq`

Both the engine API and the dashboard bind to localhost only. Neither is
authenticated, because neither is reachable from outside the machine. **Do not
port-forward them.** If you want remote access, use a VPN or an SSH tunnel.

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
