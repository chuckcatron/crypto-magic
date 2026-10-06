# The futures paper engine

`apps/futures-engine` runs the four strategies from
[`EXPERIMENT-008`](EXPERIMENT-008-fast-futures.md) forward on live Coinbase
prices, with paper money.

**Read this first: all four strategies failed EXPERIMENT-008.** None of them
had an edge before costs. This engine exists to prove the futures machinery
end to end: live data, simulated fills, risk rules, restarts, alerts. It also
collects forward data. Under the experiment's rules, good paper results cannot
make a failed strategy live. A strategy that passes a new pre-registered
experiment can be dropped into this engine as it is.

## What it can and cannot do

It **cannot place an order**. There is no exchange adapter in it and no key.
It reads only Coinbase's public candles and keeps its own database.

| It does                                                                 | It does not                                                   |
| ----------------------------------------------------------------------- | ------------------------------------------------------------- |
| Runs F1–F3 on BTC, ETH and SOL, and F4 on the 23-coin universe          | Trade, hold, or see any real money                            |
| Uses `packages/futures`, the same code the backtest ran                 | Use the perpetual's own price: like the test, it uses spot    |
| Applies the risk rules: 0.5% risk per trade, 1× cap, a 2% daily halt    | Size by contract: positions are fractional, as in the test    |
| Fills like the backtest: decide at a bar's close, fill at the next open | Stream ticks: it reads closed 5-minute bars, about every 20 s |
| Judges stops and targets on each bar's range, as exchange-side orders   | Touch the regime engine, its database, or its settings        |

Each strategy-and-coin pair is its own sub-account with $10,000 of paper
equity. That's 9 for F1–F3, plus one for the F4 rotation.

## Running it

It shares the repo, the `.env` (for the alert channels only) and the `data/`
folder with the regime engine. It uses its own port, database and kill switch.

To run it in the foreground (Ctrl-C stops it):

```bash
pnpm install
pnpm turbo run build --filter=@crypto-magic/futures-engine...
pnpm futures:paper
```

Then, from another terminal:

```bash
curl -s http://127.0.0.1:4100/api/status | jq
```

On the first start it fetches about 50 days of 5-minute bars per coin (about
150 requests) and 40 days of daily bars for the universe. The API answers
straight away, and `lastTickAt` stays null until that first pass completes.
Then it trades only on bars that close after it started.

Only one copy can run at a time. The engine claims its API port before doing
anything else, so a second copy on the same port exits at once. It does so
before touching the database or sending an alert.

### As a service on a Mac

`scripts/install-launchd-futures.sh` installs it as the launchd agent
`com.cryptomagic.futures`.

- It starts at login and restarts after a crash.
- It keeps the Mac out of idle sleep while it runs.
- It is separate from `scripts/install-launchd.sh`, and never touches the
  regime engine's services.

Run the installer from a shell whose `node -v` is the Node the engine was
built with, because the service records that `node`. Before installing, it:

- refuses a `node` the database module will not load under;
- stops a copy started by hand, if its PID is in `data/futures-paper.pid`;
- refuses to start while anything else answers on the port.

| To                               | Run                                                           |
| -------------------------------- | ------------------------------------------------------------- |
| Install or reinstall, then start | `./scripts/install-launchd-futures.sh`                        |
| Restart                          | `launchctl kickstart -k gui/$(id -u)/com.cryptomagic.futures` |
| Stop it and remove the service   | `./scripts/install-launchd-futures.sh --uninstall`            |
| Follow the log                   | `tail -f logs/futures-paper.log`                              |

Under launchd, a process you kill comes back within 30 seconds. To keep it
stopped, uninstall the service; that leaves its database alone.

## Settings

All optional. Put them in the repo-root `.env`.

| Setting                      | Default                    | Meaning                                                              |
| ---------------------------- | -------------------------- | -------------------------------------------------------------------- |
| `FUTURES_PORT`               | `4100`                     | API port, on 127.0.0.1 only                                          |
| `FUTURES_DB_PATH`            | `data/futures-paper.db`    | Its own SQLite file                                                  |
| `FUTURES_KILL_SWITCH_PATH`   | `data/FUTURES_KILL_SWITCH` | While this file exists: no new entries. Exits still run              |
| `FUTURES_STRATEGIES`         | `F1,F2,F3,F4`              | Which strategies to run                                              |
| `FUTURES_PAPER_EQUITY`       | `10000`                    | Paper equity per sub-account                                         |
| `FUTURES_POLL_SECONDS`       | `20`                       | How often it looks for newly closed bars                             |
| `FUTURES_ALERT_MIN_SEVERITY` | `warning`                  | `warning` sends daily-loss halts and errors; `info` adds every trade |

Alerts go through the same channels as the regime engine (`NTFY_TOPIC`,
Discord, Telegram). Every title starts with **PAPER futures**, so a paper fill
can't be mistaken for a real one.

## Stopping it, and the kill switch

```bash
touch data/FUTURES_KILL_SWITCH    # no new paper entries; open ones still exit
rm data/FUTURES_KILL_SWITCH       # resume
```

Stop the process with Ctrl-C, or send it SIGTERM. As a service, uninstall it
instead (above). On the next start it resumes from its database. It processes the bars it missed: open positions are
managed through them, but it makes **no new entries** on any decision more
than 10 minutes old. A bot that was down could not have made those trades.

To start over, stop it and delete `data/futures-paper.db*`.

## The dashboard

Open <http://127.0.0.1:4100> in a browser on the Mac that runs the engine. It
refreshes itself every 15 seconds and shows:

- the total paper profit and loss, in plain English;
- profit and loss over time for each strategy, as a chart and as a table;
- a card per strategy: what it does, its result, and what each coin is doing;
- open positions, with entry, current price, stop, target and open P&L;
- recent closed trades and why each closed;
- the engine's activity, plus short answers to the usual questions.

It warns, with a colored icon and a sentence, when the engine is unreachable,
behind on prices, failing, or paused by the kill switch. It follows the system's
light or dark mode; the **Theme** button overrides that.

The engine itself serves the page, so it has nothing extra to run or build. The
page only reads the API below, under a Content-Security-Policy that allows no
inline code and no other origin. Like the API, it answers only on this Mac.

From another machine, use an SSH tunnel and open <http://localhost:4100> there:

```bash
ssh -L 4100:127.0.0.1:4100 you@the-mac
```

The page's files are in `apps/futures-engine/public` and are read on each
request: an edit shows on the next reload, with no rebuild or restart.

## The API

Read-only, 127.0.0.1 only. It refuses any method but GET, any non-loopback
`Host` (DNS rebinding), and any foreign `Origin`. It has no endpoint that
changes anything.

| Endpoint                   | Returns                                                                                                                                                  |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/status`          | Each sub-account: equity, open position with its mark price and open P&L, pending entry, halted, last bar, trades, wins and net P&L; the rotation's book |
| `GET /api/equity`          | Each strategy's paper P&L at the start, at every UTC day close since, and now                                                                            |
| `GET /api/trades?limit=50` | The most recent closed paper trades                                                                                                                      |
| `GET /api/events?limit=50` | Starts, entries, exits, halts and errors                                                                                                                 |

## How it stays correct across restarts

Each tick reads the bars that have closed since the last one and feeds them
through the sub-accounts. Their state and any trades they produced are
written in one transaction. After a crash it resumes from the last commit and
replays the same bars. That regenerates the same trades, and the database's
unique key turns them into no-ops.

The strategies keep no state of their own. `packages/futures` has a test
showing that each one gives the same signals on full history as on a series
rebuilt from a recent fetch, which is what this engine does on every start.

## What going live on futures would still need

None of this exists, deliberately. It would follow a strategy passing a new
pre-registered experiment, not come before one:

1. A Coinbase Financial Markets futures account, opened by the owner.
2. A futures `ExchangeAdapter` covering orders, brackets (stop and target
   placed with the entry), positions, margin and funding. Its order paths
   would need the same never-retry and idempotency rules as the spot adapter.
3. Reconciliation against the exchange's futures positions on startup.
4. Contract sizing. One BTC contract is about $860, so the risk rules need
   roughly $1,700 or more per BTC sub-account.
5. A preflight and a going-live checklist, like `docs/GOING-LIVE.md`.
