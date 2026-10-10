# Going live

A checklist for moving from paper to real money, in order. Every step says
how to verify it. `pnpm preflight` checks most of them for you, read-only.

Read [`SAFETY.md`](SAFETY.md) first. This page is the procedure; that one is
why.

## 0. Decide before you start

- [ ] **The amount** is money whose total loss would be an annoyance, not an
      event. The regime filter's worst BTC backtest drawdown was 68%, so plan
      on seeing most of it gone at some point.
- [ ] **BTC only.** EXPERIMENT-001 is the only pre-registered pass. ETH failed
      EXPERIMENT-003, the filter failed on 26 of 27 other coins in
      EXPERIMENT-005, and adding ETH and SOL to BTC deepened the drawdown in
      EXPERIMENT-006.
- [ ] **Your stop rules, written down now,** while nothing is at stake. For
      example: "If the account is down 40%, or the bot does anything I cannot
      explain, I engage the kill switch and go back to paper." Deciding this
      mid-drawdown is how people sell the bottom.
- [ ] **Your expectations.** Most trades lose; months can pass with no trade;
      it lags a strong bull market. See the backtests in `docs/EXPERIMENT-*`
      and the Income planner on the dashboard.

## 1. Prove the machinery in paper (two weeks at least)

- [ ] The engine has run under launchd for two weeks:
      `launchctl list | grep cryptomagic` shows both services.
- [ ] It handled at least one daily close (00:00 UTC): `cm events` shows the
      evaluation, and the dashboard's "Market data" age reset.
- [ ] The **Daily check-in** arrived on your phone every day.
- [ ] **Test alert** reaches every channel.
- [ ] You engaged and released the kill switch once.
- [ ] It survived a restart and a night with the Mac asleep, with no duplicate
      orders and positions intact.
- [ ] You know where your data lives: `data/crypto-magic.db` is your only
      record of the bot's trades.

## 2. Raise the losing-streak limit (do this in paper too)

The default `MAX_CONSECUTIVE_LOSSES=4` does not fit this strategy. The halt
does not clear by itself: a streak only ends with a winning trade, and a halted
bot cannot open one. The regime filter lost 9 trades in a row on BTC in
2015–2021 and 5 in 2025–2026, and the backtests traded straight through both.
With 4, the bot would have stopped partway through each until you noticed, and
missed what followed.

- [ ] In `.env`: `MAX_CONSECUTIVE_LOSSES=12`, so the halt means "something is
      badly wrong", not "an ordinary bad patch".
- [ ] Know what happens if it trips: a critical **Trading halted** alert, and
      no new entries (exits still run). Review the losing trades, then run
      `cm reset-streak` or press **Reset losing streak** on the dashboard.
      Losses before the reset stop counting; the trade history is kept.

`MAX_DAILY_LOSS` (default $10 of realized loss) is fine to leave: it stops new
entries only until the next UTC day, and this strategy almost never re-enters
on the day it exits.

## 3. Prepare Coinbase

Coinbase scopes each API key to one portfolio, and the bot sees everything in
it. Give the bot a portfolio of its own.

- [ ] **No BTC in the portfolio except what the bot buys.** At startup the bot
      compares its record with the portfolio's whole BTC balance and adopts
      the exchange's number. BTC you already hold there would become "the
      bot's position", and its next exit would sell it.
- [ ] **Only the cash you mean to risk.** Each entry spends
      `REGIME_ALLOCATION_PCT` of all the USD the key can see. The caps in
      step 4 bound that; a portfolio holding only the bot's money makes it
      true by construction. Deposit the amount from step 0, in USD.
- [ ] **Create the API key** at
      [portal.cdp.coinbase.com](https://portal.cdp.coinbase.com) for that
      portfolio, with **View** and **Trade** only. Never grant Transfer. The key
      name looks like `organizations/…/apiKeys/…`, as in `.env.example`.
- [ ] Never paste the key into a chat, a ticket or a commit.

## 4. Configure `.env`

Put the key in `.env` yourself:

```
COINBASE_API_KEY_NAME=organizations/xxxx/apiKeys/xxxx
COINBASE_API_PRIVATE_KEY="-----BEGIN EC PRIVATE KEY-----\n...\n-----END EC PRIVATE KEY-----\n"
```

Then set, or confirm:

```
PRODUCTS=BTC-USD
STRATEGY=regime
GRANULARITY=ONE_DAY
REGIME_ALLOCATION_PCT=99
MAX_POSITION_NOTIONAL=<the amount from step 0>
MAX_TOTAL_NOTIONAL=<the same amount>
MAX_CONSECUTIVE_LOSSES=12
PROTECTIVE_STOP_ENABLED=true
HEARTBEAT_ENABLED=true
```

- [ ] At least one alert channel (`NTFY_TOPIC`, Discord or Telegram) is set.
- [ ] A dead man's switch (`DEADMAN_PING_URL`) is set: it is the only thing
      that tells you when the Mac or the engine dies.
- [ ] `chmod 600 .env`
- [ ] `git check-ignore .env` prints `.env`

**Leave `TRADING_MODE=paper` for now.** Live is armed in step 7.

## 5. Start from a fresh database

Positions are not separated by mode. A paper position left in the database
would be treated as a live one.

```bash
launchctl bootout gui/$(id -u)/com.cryptomagic.engine
A=data/archive-$(date +%F-%H%M)-paper; mkdir -p $A && mv data/crypto-magic.db* $A/
ls data/crypto-magic.db 2>/dev/null || echo "fresh: ok"
```

## 6. Run the preflight until it says READY

```bash
pnpm preflight
```

It reads, and never orders or changes anything:

- the key's permissions (it must not be able to transfer);
- the portfolio's balances (no BTC, enough USD);
- what the first buy would spend;
- the fee Coinbase charges this account;
- that the database is fresh;
- that the losing-streak limit is above 9 and an alert channel is set;
- that `.env` is private and git-ignored.

- [ ] Every line is PASS, or a WARN you have read and accepted.
- [ ] The **First buy** line shows the amount you expect. If not, fix the caps.
- [ ] The **Trading fees** line. Every backtest and the paper soak charged
      0.60% per market order. Coinbase sets the real rate per account and
      changes its schedule; after its 2026-09-16 change, reports put the US
      entry rate at 0.90%. If the line warns, live results will trail paper by
      the extra cost on every trade. Decide whether that is acceptable before
      arming live.

## 7. Arm live and watch the first trade

In `.env`:

```
TRADING_MODE=live
LIVE_TRADING_ACK=I_UNDERSTAND_THIS_SPENDS_REAL_MONEY
```

```bash
grep -E "^(TRADING_MODE|LIVE_TRADING_ACK|PRODUCTS|REGIME_ALLOCATION_PCT|MAX_.*NOTIONAL)=" .env
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.cryptomagic.engine.plist
cm restart dashboard
cm events
```

If BTC is above its 200-day average, it buys on the first check.

- [ ] `cm events` shows `engine started in live mode`, `reconciled 0
position(s)`, then `ENTER_LONG`, `order_filled` and `position_opened`
      for the amount the preflight predicted.
- [ ] The dashboard shows **● LIVE — real money** (hard-reload: ⌘+Shift+R).
- [ ] **Coinbase agrees:** the fill in your order history matches the
      dashboard's size and price.
- [ ] **The exchange-side stop was placed:** Coinbase shows an open stop-limit
      SELL for the position's size, and the log says so:
      `grep -i "protective stop" logs/engine.log | tail -3`.
      A failure also sends a warning alert. If it says `could not place`,
      engage the kill switch and find out why
      before continuing: while the engine is down, that order is the only
      floor.

About that exchange-side stop: it sits half an ATR below the engine's own
10-ATR stop, and it is a stop-**limit** with its limit 0.5% under the trigger.
In a crash that falls through both in one move, it may not fill at all.
EXPERIMENT-004 showed how far a flash crash can overshoot.

## 8. The first week

- [ ] The Daily check-in arrives every day, now saying `live`, and its first
      line reads "New entries allowed." If it says "NEW ENTRIES BLOCKED", it
      names the reason.
- [ ] After the first daily close, `cm events` shows the evaluation and no
      errors.
- [ ] Once, compare Coinbase's BTC and USD balances with the dashboard. If they
      ever disagree, believe Coinbase ([`SAFETY.md`](SAFETY.md), "When
      something looks wrong").
- [ ] Keep records for taxes. Each sale is a taxable event, and Coinbase's tax
      documents are the authoritative record.

## Going back to paper

Do not switch `TRADING_MODE` back with a live position open. Paper mode would
reconcile the live record against the paper account, which holds no BTC, and
silently delete it. The real BTC would stay on Coinbase with nothing managing
it.

1. Decide whether to keep the BTC:
   - To sell it, use **Flatten all** on the dashboard.
   - To keep it, move it out of the bot's portfolio on Coinbase.
2. Stop the engine and archive the database, as in step 5.
3. Set `TRADING_MODE=paper`, remove `LIVE_TRADING_ACK`, and start the engine.
