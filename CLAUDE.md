# Notes for Claude sessions

Handoff notes, so a new session can pick up without the old transcript. Last
updated 2026-10-10. The README and `docs/` are the real documentation. This
file covers working rules and where things stand.

## Working rules (from the owner)

- **Never add Coinbase API keys. Never commit `.env` or `data/`.**
- Be at least 90% sure before acting. Follow best practices. The owner works in
  Next.js and NestJS, and deploys to AWS with Amplify or CDK.
- Give the owner shell commands with no `#` comments. Their zsh does not treat
  `#` as a comment in pasted input, so a comment runs as part of the command,
  and an apostrophe in one opens a quote that swallows the lines after it
  (reproduced 2026-10-06).
- Work only on branch `claude/eloquent-wright-ab93he`. The owner merges PRs.
  Open a PR only when asked. They usually just say "PR".
- After a PR is merged, restart the branch from main:
  ```bash
  git fetch --prune origin
  git checkout -B claude/eloquent-wright-ab93he origin/main
  git branch --unset-upstream
  ```
- Strategy changes go through a **pre-registered experiment**:
  1. Commit and push the protocol (`docs/EXPERIMENT-NNN-*.md`) before running
     anything.
  2. Run each case once.
  3. Append the results. Never edit the protocol section afterwards.
  4. If nothing passes, nothing changes.

## Where things stand

- **The bot** is paper-trading on the owner's MacBook Pro under launchd, using
  live Coinbase public prices. Settings:
  - `STRATEGY=regime`, `GRANULARITY=ONE_DAY`
  - BTC-USD only, `REGIME_ALLOCATION_PCT=99`
  - A 10-ATR disaster stop
- **Machines.** The soak runs on the MacBook Pro. `node scripts/cm.mjs` there
  on 2026-10-06 showed:
  - the loop live and the dead-man pinging;
  - one position, 0.01184166 BTC bought 9 days earlier at $83,603.04;
  - equity $1,015.97 from $1,000.

  The Mac Studio's `~/crypto-magic` has no regime bot. The doctor there showed
  no `.env`, no build, no launchd service and nothing on port 4000.
  better-sqlite3 would not build there on Node 24.21.0, so the owner switched
  it to Node 22. The futures paper engine has run there since 2026-10-06 19:25
  UTC, started by hand with `nohup` (PID in `data/futures-paper.pid`).
  `scripts/install-launchd-futures.sh`, added the same day, moves it under
  launchd as `com.cryptomagic.futures`. Until the owner confirms they ran it
  there, assume a reboot stops the engine.

- **better-sqlite3 11.10.0**, used by both engines, ships ready-made Mac
  binaries for Node 20, 22 and 23 only.
  - On Node 24 it has to compile from source. That worked in the Linux sandbox
    but not on the Mac Studio. `pnpm install --reporter=append-only` shows a
    compile's output.
  - It cannot compile on Node 26: V8 removed APIs it uses.
  - Keep the Macs on Node 22, which reaches end of life on 2027-04-30.
  - 12.11.1 ships Mac binaries for Node 22, 24 and 26. Upgrading to it after
    the soak is the way onto Node 24.
- **The paper soak** is step 1 of `docs/GOING-LIVE.md`, which asks for at least
  two weeks. It runs to about **2026-10-13**. Going live after that means
  working through `docs/GOING-LIVE.md` in order, up to `pnpm preflight`
  reporting READY. The owner creates and installs the keys, never Claude.
- **Experiments** (details in `docs/`):

  | No. | Question                       | Result                                               |
  | --- | ------------------------------ | ---------------------------------------------------- |
  | 001 | 200-day regime filter on BTC   | Passed, provisionally. This is the live strategy     |
  | 002 | Funding-rate carry             | Real income, but not steady. Not adopted             |
  | 003 | Regime filter on ETH and SOL   | ETH failed. SOL passed only its one window           |
  | 004 | Better disaster stops          | No variant passed. Stop unchanged                    |
  | 005 | Close-only stop on other coins | Inconclusive. The filter failed on 26 of 27 altcoins |
  | 006 | Three coins or BTC alone       | BTC alone, but the result is fragile                 |
  | 007 | Faster exit line               | Neither variant passed. Exit unchanged               |
  | 008 | Fast long/short on US perps    | All four failed. No edge before costs                |
  | 009 | "Trade any crypto" bots        | All six failed. All lost money in 2023–2026          |
  | 010 | Volatility-targeted sizing     | Lost window 1 by 0.63 points. Sizing unchanged       |
  | 011 | Maker limit orders             | Passed all six cells, about 23 bps a fill. Not built |

- **Fee sensitivity**, run 2026-10-02 and not committed as an experiment.
  Regime strategy, full exposure. Each cell is annualized return / max
  drawdown:

  | Window    | Coinbase 60 bps taker | 25 bps (Alpaca tier 1) |
  | --------- | --------------------- | ---------------------- |
  | 2015–2021 | 78.83% / −68.38%      | 82.44% / −67.71%       |
  | 2022–2024 | 52.01% / −29.58%      | 54.68% / −27.32%       |
  | 2025–2026 | −8.09% / −35.37%      | −4.48% / −33.07%       |

  Lower fees are worth about 3 points a year. They do not fix the 2025–2026
  loss.

- **Fast trading on futures (2026-10-06).** The owner asked for an aggressive,
  fast bot on Coinbase that trades any crypto, long and short.
  - Measured first: at spot fees (1.3% a round trip), even perfect hindsight
    beats the cost on only 0.6% of 15-minute BTC bars. Coinbase's US perpetual
    futures (`BIP-20DEC30-CDE` etc.) cost about a tenth as much.
  - EXPERIMENT-008 tested four strategies on futures costs: F1 flush catcher,
    F2 squeeze breakout, F3 trend pullback, F4 weekly momentum across 23
    coins. All four failed both windows. F1–F3 capture about zero per trade
    before costs.
  - F4 made +47% before costs in the holdout, but the both-sides funding
    assumption took most of it. Noted in the doc, not acted on.
  - `packages/futures` holds the simulation. `apps/futures-engine` is a
    paper-only engine that runs the four forward on live public prices: port
    4100, its own `data/futures-paper.db`, no key, no order path. The owner
    said "build it with futures in mind; you are free to paper trade". It runs
    on the Mac Studio (see Machines). `scripts/install-launchd-futures.sh`
    makes it a launchd agent, separate from the regime services. The engine
    claims its API port before trading, so a second copy exits before touching
    the database. See `docs/FUTURES-PAPER.md`.
  - Its dashboard is at <http://127.0.0.1:4100>. The owner asked for it to be
    "super user friendly". The engine serves it from
    `apps/futures-engine/public` (plain HTML, CSS and JS, no build step) under
    a CSP that allows no inline code. It is read-only, like the API.
  - Visual QA was done in the sandbox with Playwright's Chromium, against a
    fixture server and against the real engine. The chart colors are
    dataviz-validated categorical slots 1–4.
- **Muggli.** The owner's friend Tom ("Muggli") reports +200% in 5 months, live
  since about May 2026, with a bot that trades any crypto. He started from a
  backtest and trades bitcoin he mined. Asked for, but not received: his trade
  history CSV and his rules. Over 2026-05-06 → 2026-10-05, BTC held made +5%,
  the median of the top 96 coins +15%, and 6 coins tripled.
- **EXPERIMENT-009 (2026-10-06)** tested the archetypes Muggli could be
  running, on a survivorship-free universe.
  - The universe: every Binance USDT pair from the public archive, delisted
    ones included (191 of 589). It was fetched with
    `scripts/fetch-binance-daily.mjs` through the archive's S3 endpoint, which
    the sandbox allows.
  - All six failed. In the holdout, all lost money while BTC made +36% a year.
  - The gated breakout (S2R) made +43% over Muggli's five months but lost
    about 57% in each of 2024 and 2025. His number fits a hot streak of a
    breakout-style bot.
  - The BTC 200-day filter nearly tied its yardstick in that holdout (+22.0%
    against +23.0%).
  - The simulation is `packages/futures/src/portfolio`.
- **Popular GitHub bots (2026-10-10).** The owner asked which trending crypto
  trading project looks most promising. Read, not run: TradingAgents,
  ai-hedge-fund, freqtrade, nautilus_trader, hummingbot, NoFx, vibe-trading and
  ai-trading-agent.
  - None shows a verified edge.
  - Nautilus Trader is the best fit for Coinbase's US perpetuals: its Coinbase
    adapter is marked stable and covers spot and CFM futures.
  - Hummingbot's market making suits a high-trade-count style like Muggli's,
    but retail fees work against it.
  - NoFx has red flags: a `curl | bash` installer, a fee wallet for its AI,
    non-US exchanges, and AGPL.
- **Freqtrade (2026-10-10).** The owner asked "can we run freqtrade". Yes, in
  paper mode ("dry-run") with no key. Freqtrade 2026.9 was tested in the
  sandbox:
  - It reaches Coinbase only through ccxt ("Coinbase Advanced"), which
    freqtrade does not officially support, and logs a warning saying so.
  - It downloaded hourly candles and backtested. It ran a live dry-run for
    five minutes, with its API and login working.
  - Coinbase needs `"use_order_book": false` in `entry_pricing` and
    `exit_pricing`. ccxt's Coinbase has no `fetchL2OrderBook`, so the
    order-book setting stops freqtrade at startup.
  - Its demo `SampleStrategy` was backtested on BTC, ETH and SOL hourly from
    2025-10-15 to 2026-10-10, with $1,000 and 3 slots. Results by fee per side:
    −55% at 0.6%, −49% at 0.4%, −29% at zero. Holding the three lost 38%;
    BTC alone lost 27%. It won 75% of its trades, but its −11% stop-loss
    exits outweighed the many +1% wins.
  - Its docs say Apple-silicon Macs should run it in Docker. The owner was
    given steps for the Mac Studio, not yet confirmed running there:
    - `~/freqtrade`, outside this repo;
    - the official `docker-compose.yml`;
    - a Coinbase dry-run config with no key;
    - FreqUI at <http://127.0.0.1:8080>.
  - A freqtrade strategy that might trade real money goes through a
    pre-registered experiment, like any other.

## Open threads

- **Coinbase's real fee rate.** The soak and backtests charge 60 bps taker.
  ccxt's Coinbase fallback, copied from a Coinbase API response, puts the tier
  under $1K of 30-day volume at 1.2% taker and 0.6% maker. 2026 fee guides
  disagree with each other. Nothing on the going-live path checks the rate.
  - EXPERIMENT-011 also assumed 60 bps taker and 40 bps maker. At 1.2% and
    0.6%, the gap a filled maker order saves is 65 bps, not 25.
  - A task was suggested to the owner: have the live preflight read the
    account's `transaction_summary` fee tier and warn when the taker rate is
    above 60 bps.
  - Don't change the soak's fee while it runs.
- **Alpaca (alpaca.markets).** The owner asked whether moving to a "proven
  platform" would do better.
  - Answer so far, based on web search: not yet. The fee saving is small, and
    switching means:
    - writing a new `ExchangeAdapter`
    - redoing reconciliation, the protective stop, and the preflight key checks
  - Alpaca's crypto is not SIPC-covered.
  - Recommendation: finish the Coinbase soak first.
  - The site itself was never read. In the cloud sandbox, WebFetch is blocked
    for that domain, but `curl` gets through. Reading the actual pages could
    confirm or correct the search-based answer:
    - `docs.alpaca.markets/docs/crypto-fees`
    - `docs.alpaca.markets/docs/crypto-orders`
- **Offered, no answer yet. Don't start without a yes:**
  - Auditing Muggli's trade history, if he shares it: real return after fees
    and deposits, drawdown, what carried it, and against holding the same coins.
  - A new pre-registered experiment on F4 with real funding history. It would
    run on data EXPERIMENT-008 has already seen, so it starts as weaker
    evidence. EXPERIMENT-009 already tested long-only gated rotation (S1R),
    which failed.
  - Upgrading better-sqlite3 to 12.11.1 after the soak, then moving both Macs
    to Node 24. It is a major version, so read its breaking changes first.
  - A pre-registered experiment running the regime filter on SPY. Alpaca's
    real advantage is commission-free stocks and ETFs.
  - Building maker limit orders into the engine, which EXPERIMENT-011
    supports. Its doc says: a separate, reviewed change, tested on paper first.
  - A pre-registered, forward-only paper test of TradingAgents. It would need
    the owner's own AI API key.

## Useful commands

```bash
pnpm test && pnpm typecheck
node scripts/cm.mjs              # status; `kill`, `flatten`

# Regime backtest on a CSV (run from apps/engine)
npx tsx src/backtest/run-backtest.ts --granularity ONE_DAY --strategy regime \
  --sma-period 200 --full-exposure --product BTC-USD \
  --csv ../../data/btc-cb-daily.csv --trade-from 2022-01-01 --to 2025-01-01 \
  --taker-bps 60          # defaults: 60 taker + 5 slippage
```

```bash
# EXPERIMENT-008 (the data commands are in the doc's process notes)
pnpm --filter @crypto-magic/futures validate-008
pnpm --filter @crypto-magic/futures experiment-008 --window dev   # or holdout

# EXPERIMENT-009 (data: scripts/fetch-binance-daily.mjs, fetch-coinbase-history.mjs)
pnpm --filter @crypto-magic/futures inventory-009
pnpm --filter @crypto-magic/futures experiment-009 --window dev   # or holdout

# Futures paper engine (after pnpm build)
pnpm futures:paper
curl -s http://127.0.0.1:4100/api/status
open http://127.0.0.1:4100              # the dashboard (macOS)
./scripts/install-launchd-futures.sh   # macOS: as a launchd agent; --uninstall removes it
```

The CSVs live in `data/`, which is gitignored, so a fresh clone won't have
them. `scripts/fetch-btc-history.mjs` rebuilds the BTC history.
`scripts/fetch-coinbase-history.mjs` fetches any product at any granularity.
In the cloud sandbox, Node's fetch needs `NODE_USE_ENV_PROXY=1`.
