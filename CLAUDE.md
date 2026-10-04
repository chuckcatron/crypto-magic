# Notes for Claude sessions

Handoff notes, so a new session can pick up without the old transcript. Last
updated 2026-10-02. The README and `docs/` are the real documentation. This
file covers working rules and where things stand.

## Working rules (from the owner)

- **Never add Coinbase API keys. Never commit `.env` or `data/`.**
- Be at least 90% sure before acting. Follow best practices. The owner works in
  Next.js and NestJS, and deploys to AWS with Amplify or CDK.
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

- **The bot** is paper-trading on the owner's Mac under launchd, using live
  Coinbase public prices. Settings:
  - `STRATEGY=regime`, `GRANULARITY=ONE_DAY`
  - BTC-USD only, `REGIME_ALLOCATION_PCT=99`
  - A 10-ATR disaster stop
- **The paper soak** is step 1 of `docs/GOING-LIVE.md`, which asks for at least
  two weeks. It started 2026-09-27 and runs to **2026-10-11**. Going live after that means
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

## Open threads

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
  - A pre-registered experiment running the regime filter on SPY. Alpaca's
    real advantage is commission-free stocks and ETFs.
  - Using Coinbase maker limit orders (about 40 bps) instead of market orders,
    as a cheaper fee improvement.

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

The CSVs live in `data/`, which is gitignored, so a fresh clone won't have
them. `scripts/fetch-btc-history.mjs` rebuilds the BTC history.
