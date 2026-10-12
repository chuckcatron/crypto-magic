#!/usr/bin/env bash
#
# Install the futures paper engine as a launchd agent, so it starts at login,
# restarts if it dies, and keeps the Mac awake while it runs. macOS only. Run
# from the repo root, in a shell whose `node` is the one the engine should use:
#
#   ./scripts/install-launchd-futures.sh               install (or reinstall) and start it
#   ./scripts/install-launchd-futures.sh --uninstall   stop it and remove the service
#
# Separate from scripts/install-launchd.sh on purpose: that one manages the
# regime engine and its dashboard, and this one never touches them.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
AGENTS="$HOME/Library/LaunchAgents"
LABEL="com.cryptomagic.futures"
PLIST="$AGENTS/$LABEL.plist"
WRAPPER="$REPO_ROOT/scripts/run-futures.sh"
PID_FILE="$REPO_ROOT/data/futures-paper.pid"

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "This installer is for macOS. On Linux, use a systemd unit instead." >&2
  exit 1
fi
DOMAIN="gui/$(id -u)"

is_loaded() { launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1; }

# Unload the service and wait until launchd has let go of it: bootstrapping
# straight after a bootout can fail with a misleading "Input/output error".
unload() {
  is_loaded || return 0
  launchctl bootout "$DOMAIN/$LABEL" || true
  for _ in $(seq 1 30); do
    is_loaded || return 0
    sleep 1
  done
  echo "launchd still has $LABEL loaded after 30 seconds." >&2
  exit 1
}

if [[ "${1:-}" == "--uninstall" ]]; then
  unload
  rm -f "$PLIST" "$WRAPPER"
  echo "Removed the $LABEL service. Its paper database in data/ is untouched."
  exit 0
elif [[ -n "${1:-}" ]]; then
  echo "Unknown option: $1 (the only option is --uninstall)" >&2
  exit 1
fi

# Last assignment of KEY in .env, quotes stripped (as in scripts/doctor.sh).
env_value() {
  [[ -f "$REPO_ROOT/.env" ]] || return 0
  grep -E "^[[:space:]]*$1=" "$REPO_ROOT/.env" | tail -n 1 | cut -d= -f2- | sed -E 's/^[[:space:]]*//; s/[[:space:]]+#.*$//; s/^"(.*)"$/\1/; s/^'"'"'(.*)'"'"'$/\1/'
}
PORT="$(env_value FUTURES_PORT || true)"
PORT="${PORT:-4100}"
STATUS_URL="http://127.0.0.1:$PORT/api/status"

NODE_BIN="$(command -v node || true)"
if [[ -z "$NODE_BIN" ]]; then
  echo "node not found on PATH." >&2
  exit 1
fi

if [[ ! -f "$REPO_ROOT/apps/futures-engine/dist/main.js" ]]; then
  echo "The futures engine is not built. Run:" >&2
  echo "  pnpm turbo run build --filter=@crypto-magic/futures-engine..." >&2
  exit 1
fi

# The service runs this node, and the engine's database module (better-sqlite3)
# loads only under the Node it was built for. Refuse a node it will not load
# under, or launchd would restart a crashing engine every 30 seconds.
if ! FUTURES_DIR="$REPO_ROOT/apps/futures-engine" "$NODE_BIN" -e \
  "require(require('path').dirname(require.resolve('better-sqlite3/package.json', { paths: [process.env.FUTURES_DIR] })))(':memory:')" \
  >/dev/null 2>&1; then
  echo "The database module will not load under $NODE_BIN ($("$NODE_BIN" -v))." >&2
  echo "Run this from a shell on the Node you installed with, or rebuild the module" >&2
  echo "for this one (docs/RUNBOOK.md, \"Changing Node versions\")." >&2
  exit 1
fi

# A copy started by hand (docs/FUTURES-PAPER.md) holds the port, and the
# service cannot start while it does. Stop it, but only if that PID is still
# the futures engine: a PID file can outlive its process.
if [[ -f "$PID_FILE" ]]; then
  pid="$(cat "$PID_FILE")"
  command_line=""
  if [[ "$pid" =~ ^[0-9]+$ ]]; then
    command_line="$(ps -p "$pid" -o command= 2>/dev/null || true)"
  fi
  if [[ "$command_line" == *futures-engine/dist/main.js* ]]; then
    echo "Stopping the copy started by hand (PID $pid)..."
    kill "$pid" 2>/dev/null || true
    for _ in $(seq 1 30); do
      kill -0 "$pid" 2>/dev/null || break
      sleep 1
    done
    if kill -0 "$pid" 2>/dev/null; then
      echo "PID $pid did not stop within 30 seconds. Stop it, then run this again." >&2
      exit 1
    fi
  fi
  rm -f "$PID_FILE"
fi

unload

if curl -s -m 3 -o /dev/null "$STATUS_URL"; then
  echo "Something else still answers on 127.0.0.1:$PORT, so the service could not start." >&2
  echo "Stop it first. It may be a copy started with 'pnpm futures:paper' in another terminal." >&2
  exit 1
fi

mkdir -p "$AGENTS" "$REPO_ROOT/logs" "$REPO_ROOT/data"

# Like the regime engine's wrapper: caffeinate holds off idle sleep for exactly
# as long as node runs, because `-w $$` watches this shell's PID, which `exec`
# hands to node. node then gets launchd's signals directly.
cat > "$WRAPPER" <<'WRAPPER_EOF'
#!/usr/bin/env bash
set -euo pipefail
cd "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
/usr/bin/caffeinate -i -s -w $$ &
exec node apps/futures-engine/dist/main.js
WRAPPER_EOF
chmod +x "$WRAPPER"

cat > "$PLIST" <<PLIST_EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$LABEL</string>

  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>$WRAPPER</string>
  </array>

  <key>WorkingDirectory</key>
  <string>$REPO_ROOT</string>

  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>$(dirname "$NODE_BIN"):/usr/local/bin:/usr/bin:/bin</string>
  </dict>

  <key>RunAtLoad</key>
  <true/>

  <!-- Restart if it exits. Safe: it trades paper only, resumes from its
       database, and a second copy stops before trading while one holds the
       port. -->
  <key>KeepAlive</key>
  <true/>

  <key>ThrottleInterval</key>
  <integer>30</integer>

  <key>StandardOutPath</key>
  <string>$REPO_ROOT/logs/futures-paper.log</string>
  <key>StandardErrorPath</key>
  <string>$REPO_ROOT/logs/futures-paper.error.log</string>

  <key>ProcessType</key>
  <string>Background</string>
</dict>
</plist>
PLIST_EOF

launchctl bootstrap "$DOMAIN" "$PLIST"
echo "Started $LABEL under $NODE_BIN ($("$NODE_BIN" -v)). Waiting for it to answer..."
for _ in $(seq 1 60); do
  if curl -s -m 3 -o /dev/null "$STATUS_URL"; then
    echo "It is up. It starts again at login and after a crash."
    echo
    echo "Status:     curl -s $STATUS_URL | jq"
    echo "Log:        tail -f $REPO_ROOT/logs/futures-paper.log"
    echo "Restart:    launchctl kickstart -k $DOMAIN/$LABEL"
    echo "Uninstall:  ./scripts/install-launchd-futures.sh --uninstall"
    exit 0
  fi
  sleep 2
done
echo "It has not answered after 2 minutes. Read the logs:" >&2
echo "  tail -n 50 $REPO_ROOT/logs/futures-paper.log $REPO_ROOT/logs/futures-paper.error.log" >&2
exit 1
