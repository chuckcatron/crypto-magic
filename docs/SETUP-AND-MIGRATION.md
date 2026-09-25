# Setup now, migrate later

Run the bot on the MacBook Pro now, and move it to the Mac Studio when that
arrives, without losing the paper account, open positions or history.

The design that makes the move easy:

| What | Where it lives | How it moves |
|---|---|---|
| Code | git | `git clone` on the new Mac, then build |
| Settings and secrets | `.env` (never committed) | `scripts/migrate.sh` |
| Everything the bot remembers: paper account, positions, trades, equity curve, kill switch | `data/` (never committed) | `scripts/migrate.sh` |
| Machine-specific choices (which local model, and so on) | a few lines in `.env` | edit after import |
| launchd service, Tailscale, SSH keys, Ollama | the Mac itself | set up again (about 20 minutes) |

Keep `DATABASE_PATH` and `KILL_SWITCH_FILE` at their defaults. Relative paths
resolve against the repo root, so they move with the repo. `./scripts/doctor.sh`
warns if you set absolute ones.

---

## Part 1 — This weekend, on the MacBook Pro (about 2 hours)

### 1. Tools (15 min)

```bash
xcode-select --install                 # compiler, in case a native module needs building
brew install node@22 pnpm git
echo 'export PATH="/opt/homebrew/opt/node@22/bin:$PATH"' >> ~/.zprofile
exec zsh -l
node -v                                # v22.x
```

### 2. Code (10 min)

```bash
cd ~
git clone -b claude/crypto-trading-bot-yqnlng https://github.com/chuckcatron/crypto-magic.git
cd crypto-magic
pnpm install
pnpm build
pnpm test                              # optional; every test should pass
```

If the repository is private, `git clone` asks for credentials. The simplest fix
is `brew install gh && gh auth login` first.

### 3. Settings (20 min)

```bash
cp .env.example .env
chmod 600 .env
```

Edit `.env`. For this weekend:

| Setting | Value | Why |
|---|---|---|
| `TRADING_MODE` | `paper` (the default) | No real money, and no API key needed |
| `PAPER_STARTING_CASH` | what you would actually trade, e.g. `1000` | So the paper results mean something |
| `NTFY_TOPIC` | a long random name, e.g. `crypto-magic-8f3k2p9wqz` | Easiest alert channel: install the **ntfy** app on your iPhone and subscribe to that topic |
| `DEADMAN_PING_URL` | from healthchecks.io | Alerts you when the bot goes silent (docs/REMOTE-ACCESS.md, step 4) |
| `LLM_ENABLED` | `false` for now | 16 GB is tight for a local model next to everything else; turn it on at the Studio |

### 4. First run, in the foreground (15 min)

```bash
pnpm engine                            # terminal 1: watch it start
node scripts/cm.mjs                    # terminal 2: status
pnpm dashboard                         # terminal 3: http://localhost:3000
```

Send yourself a test alert from the dashboard's alerts panel, or:

```bash
curl -X POST localhost:4000/api/alerts/test -H 'x-crypto-magic-request: 1'
```

**Checkpoint:** `cm` shows `Loop  last pass Ns ago`, the dashboard loads, and
the test alert reached your phone.

### 5. Run it as a service (10 min)

Stop the foreground engine (Ctrl-C), then:

```bash
./scripts/install-launchd.sh
launchctl load ~/Library/LaunchAgents/com.cryptomagic.engine.plist
node scripts/cm.mjs
```

It now starts when you log in and restarts itself if it crashes. The paper
account is saved in the database, so restarts no longer reset it.

### 6. Keep the laptop awake

- Plugged in, **lid open**. A closed lid sleeps the Mac no matter what else you set.
- Amphetamine: start a session set to **Indefinitely**.
- **System Settings → Battery → Options:** turn on *Prevent automatic sleeping on
  power adapter when the display is off*.

### 7. Phone access (30 min)

Follow [`REMOTE-ACCESS.md`](REMOTE-ACCESS.md): Tailscale, key-only SSH, the `cm`
alias, and the dead-man's switch. **Test the dead-man alert once** by stopping
the engine and waiting for it.

### 8. Check everything

```bash
./scripts/doctor.sh                    # every line ✓ or an understood !
```

### Living with it until the Studio arrives

- Use the laptop normally, but keep it plugged in with the lid open.
- Don't also run `pnpm engine` in a terminal. The service is already running,
  and the second copy fails to start because the port is taken.
- After a macOS update restart, log in: launchd brings the engine back.
- Look at `cm` and the daily check-in. That's the job for these weeks.

### What it is trading

The engine currently runs `ta-ensemble-v1`, **which lost to buy-and-hold in every
backtest** (docs/BACKTEST.md). This weekend is a shakedown of the machinery:
alerts, restarts, phone access, the paper account. It is not a test of a
profitable strategy. The regime filter, the only strategy that passed a backtest,
gets wired in next. Do not switch to live with the current strategy.

---

## Part 2 — Migration day, when the Studio arrives (about 1 hour)

### On healthchecks.io, first

**Pause** the dead-man check, so the migration gap doesn't page you.

### On the MacBook Pro

```bash
node scripts/cm.mjs                    # screenshot this: equity and positions
launchctl unload ~/Library/LaunchAgents/com.cryptomagic.engine.plist
./scripts/migrate.sh export            # → ~/crypto-magic-state-<date>.tar.gz
```

AirDrop the archive to the Studio. It contains your keys, so don't email it or
put it in cloud storage.

### On the Studio

Do Part 1 steps 1 and 2 (tools and code), then:

```bash
cd ~/crypto-magic
./scripts/migrate.sh import ~/Downloads/crypto-magic-state-*.tar.gz
```

Edit `.env` for the Studio:

```bash
LLM_ENABLED=true
OLLAMA_MODEL=qwen3-coder:30b
OLLAMA_KEEP_ALIVE=5m
```

Set up Ollama for the 48 GB machine (full 256K context, entirely on the GPU):

```bash
# install the Ollama app from https://ollama.com/download and open it once
launchctl setenv OLLAMA_FLASH_ATTENTION 1
launchctl setenv OLLAMA_KV_CACHE_TYPE q8_0
launchctl setenv OLLAMA_CONTEXT_LENGTH 262144
# quit and reopen the Ollama app so it picks these up
ollama pull qwen3-coder:30b
ollama run qwen3-coder:30b "say hi" --verbose   # look at "eval rate": expect ~110-120 tokens/s
ollama ps                                       # expect PROCESSOR 100% GPU, SIZE ~32 GB
```

`launchctl setenv` lasts until the next reboot. Re-run those three lines after a
restart, or make them permanent later.

Start it and compare with the screenshot:

```bash
./scripts/install-launchd.sh
launchctl load ~/Library/LaunchAgents/com.cryptomagic.engine.plist
./scripts/doctor.sh
node scripts/cm.mjs                    # same equity and positions as the screenshot
```

Then redo phone access on the Studio:

- Tailscale: sign in, then **disable key expiry** for the Studio.
- Remote Login on, for your account only.
- Copy `~/.ssh/authorized_keys` from the laptop.
- Change the host in your SSH app to the Studio's Tailscale name.

Finally, **resume** the dead-man check on healthchecks.io.

### Retire the laptop as a trading machine (don't skip this)

```bash
# on the MacBook Pro
rm ~/Library/LaunchAgents/com.cryptomagic.engine.plist
rm ~/crypto-magic-state-*.tar.gz
```

The launchd service starts the engine **at every login**. Leave it installed and
the next time you log in to the laptop, two bots trade one account. Keep the repo
on the laptop for development if you like, in paper mode, with no live keys in
its `.env`.

Delete the archive from the Studio's Downloads folder too, once `cm` looks right.

### If something goes wrong on the Studio

Stop it (`launchctl unload …`). The laptop's `data/` is untouched by the export,
so you can load the laptop's service again and be exactly where you were. Just
never run both at once.
