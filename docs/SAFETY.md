# Safety

Read this before setting `TRADING_MODE=live`.

## The honest part first

This bot can lose money. Not as a disclaimer — as the expected outcome of some
weeks. A trend-following strategy in a sideways market loses a little on most
trades and makes it back on a few big ones. If you cannot sit through a month of
small losses without switching it off, the strategy will not get the chance to
work, and you should not run it.

Nothing here predicts the market. The whole design is about bounding what
happens when it is wrong.

**Only trade money you would shrug at losing entirely.** Not "money I could
afford to lose" — money whose total loss would be an annoyance, not an event.

## What protects you

### Live mode takes three switches

`TRADING_MODE=live`, the exact `LIVE_TRADING_ACK` phrase, and credentials. A
typo in one leaves you in paper mode with a clear error.

### Paper mode physically cannot trade

It is handed a Coinbase adapter constructed without credentials, which throws on
every order method. It is not "paper mode checks a flag before ordering" — there
is no reachable code path to a real order.

This holds **even when live keys are in `.env`**. An earlier version forwarded
credentials to paper mode's market-data adapter whenever they were present, which
quietly broke this guarantee in its most likely real-world configuration: you set
up live, then switch back to paper to test something. Found and fixed in the
security review; `exchange.module.test.ts` pins it.

### Hard caps, enforced independently of the strategy

Every order passes a risk engine that knows nothing about the strategy's
reasoning. Defaults:

| Cap | Default |
|---|---|
| Total exposure | $100 |
| Per position | $25 |
| Open positions | 4 |
| Risk per trade | 1% of equity |
| Daily realized loss | $10 → halt |
| Consecutive losses | 4 → halt |
| Orders per hour | 12 |
| Slippage | 0.5% → kill switch |

A strategy bug that wants to buy $50,000 of anything gets $25.

### Exits are never blocked

Every halt — kill switch, daily loss, losing streak, stale data, rate limit —
stops *entries only*. A halt that trapped you in a losing position would be
worse than the thing that caused it.

### Orders cannot duplicate

Each order carries a deterministic id derived from what it is *for* — mode,
product, side, the bar that triggered it, purpose — not from when it was sent.
The intent is written to SQLite *before* the network call. Crash mid-order,
restart, and the same decision produces the same id, which is refused locally.

An ambiguous submission failure is never retried. It engages the kill switch so
a human checks the exchange before the bot acts again.

### It verifies its own holdings on startup

Before trading, the engine reconciles against real exchange balances. If they
disagree with its records it adopts the exchange's numbers and halts for review.
A bot that believes it holds less than it does leaves coins outside the stop
logic.

### Positions have a floor even when the bot is dead

An exchange-side stop-limit is placed below the engine's own trailing stop. The
engine normally exits first at the tighter level; the exchange-side one is for
when the process is not running to enforce it. Power cut at 3am with an open
position is the case it exists for.

### Money is never a float

Sizes and prices are arbitrary-precision decimals end to end, stored as TEXT in
SQLite and serialized as strings over the API. Sizes always round *down*.

### A web page cannot drive the bot

The engine binds `127.0.0.1`, which keeps the network out. It does not keep your
**browser** out, and your browser runs other people's code. Before the security
review, any page you visited while the bot ran could have released the kill
switch or sold every position, with a single `fetch(..., { mode: 'no-cors' })`.
CORS does not prevent that — it only hides the response; the request still lands.

Both the engine and the dashboard proxy now refuse:

- any request whose `Host` is not loopback (defeats DNS rebinding, where a
  hostile domain re-resolves itself to `127.0.0.1`);
- any request carrying a foreign `Origin`, including the opaque `null` origin;
- any state-changing request without an `x-crypto-magic-request: 1` header,
  which a browser cannot add cross-origin without a preflight the engine never
  approves.

The engine enables no CORS at all — no browser ever needs to call it directly,
since the dashboard goes through its own server-side proxy. And the dashboard now
binds to `127.0.0.1` too; it previously listened on every interface, which made
the engine's own loopback binding moot to anyone on the same Wi-Fi.

### Money-placing calls are never retried

The adapter retries transient failures on reads. It never retries an order
submission: a reset connection or timeout is exactly the case where Coinbase may
already hold the order. That failure surfaces immediately, the executor engages
the kill switch, and a human checks the exchange before anything else happens.

An earlier version documented this rule while silently breaking it — both
submission paths went through the retrying wrapper, so one intended order could
become up to four requests. Found in the security review; a test demonstrates
the old code submitting three times and the fixed code once.

### You are told when it stops itself

Every halt, kill-switch trip and reconciliation mismatch pushes to your phone,
at a priority that bypasses quiet hours. Without this the bot's safety
machinery is only half useful: it stops itself correctly and then waits
silently for you to notice.

Alerting cannot affect trading. The listener runs inside the event write but
only enqueues; delivery happens on a later tick, so a hung webhook cannot delay
a stop check. Every channel failure is swallowed and recorded.

### The local model cannot trade

If you enable trade reviews, be clear about what that does and does not add.

The model reads trades that have **already closed** and writes prose into the
log. It runs on its own timer, outside the trade loop. It has no access to the
exchange adapter, the risk engine or the position store. The worst a compromised
or hallucinating model can do is write something wrong in a review you then read
and believe.

That last part is the real risk, and it is yours, not the software's. A small
local model will sometimes produce a confident, well-written, wrong explanation
of why a trade lost. Treat a review as a prompt to go look at the chart, never
as a finding. If a review ever makes you want to change the strategy, verify the
claim in the backtester first.

The bot does not read its own reviews. Nothing the model writes feeds back into
a future decision.

## What does NOT protect you

Be clear-eyed about the gaps.

- **Exchange risk.** Coinbase can halt trading, delist a pair, freeze an account
  or go down mid-position. The bot handles the API errors; it cannot handle not
  being able to sell.
- **Gap risk.** Crypto trades 24/7 but still gaps. A stop at $59,000 does not
  fill at $59,000 if the market prints $52,000 next. Stops bound your *intent*,
  not your worst case.
- **Your Mac.** If it sleeps, loses Wi-Fi, or runs out of disk, the engine stops
  managing positions. The exchange-side stop is the backstop; see the runbook.
- **Alerting cannot report its own death.** Alerts only fire while the process
  runs, so a crashed bot sends nothing — which looks identical to a quiet day.
  The daily check-in is the mitigation, and it only works if you notice it
  missing. Treat that as a genuine gap, not a solved problem.
- **Key compromise.** Anyone with your `.env` can trade your account. Use a key
  with no withdraw permission so the worst case is bad trades, not an empty
  account, and lock the file down: `chmod 600 .env`.
- **Anything already running as you.** The API guard stops web pages. It does
  not stop malware or a rogue script running under your user account, which can
  read `.env` directly and call the API with the header. Nothing short of
  keeping the machine clean defends against that.
- **A persuasive review.** The model's job is to sound reasonable, which it
  will manage even when it is wrong. It is a reading aid, not an analyst.
- **Strategy risk.** The biggest one. The code does what it says; whether what
  it says makes money is genuinely unknown.

## Before going live

- [ ] Backtested over at least a year, and compared against buy-and-hold
- [ ] Ran in paper mode for two weeks and read the trades it took
- [ ] Caps set to an amount you would shrug at losing
- [ ] API key has Trade + View, **not** transfer or withdraw
- [ ] `.env` is not in git (`git check-ignore .env` prints `.env`)
- [ ] `.env` is readable only by you (`chmod 600 .env`)
- [ ] Neither port 3000 nor 4000 is forwarded on your router
- [ ] You have engaged and released the kill switch once, so you know it works
- [ ] You know where `data/crypto-magic.db` is and that it is your only record

## When something looks wrong

1. `touch data/KILL_SWITCH` — stops new entries immediately.
2. Decide whether to flatten. The dashboard's **Flatten all** sells at market.
3. Check the exchange directly. The bot's view can be wrong; Coinbase's is not.
4. Read `data/` and the engine log before restarting — startup reconciliation
   will adopt whatever the exchange says.

If the bot and the exchange disagree about what you hold, believe the exchange.
