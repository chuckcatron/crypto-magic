#!/usr/bin/env bash
#
# Install crypto-magic as two launchd agents, the engine and the dashboard, so
# both start at login and restart if they die. macOS only. Run from the repo
# root: ./scripts/install-launchd.sh
#
# The dashboard is a separate service so it can never take the engine down
# with it: a crashed or stopped dashboard leaves trading untouched.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
AGENTS="$HOME/Library/LaunchAgents"
ENGINE_LABEL="com.cryptomagic.engine"
DASHBOARD_LABEL="com.cryptomagic.dashboard"

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "This installer is for macOS. On Linux, use a systemd unit instead." >&2
  exit 1
fi

NODE_BIN="$(command -v node || true)"
if [[ -z "$NODE_BIN" ]]; then
  echo "node not found on PATH." >&2
  exit 1
fi

if [[ ! -f "$REPO_ROOT/apps/engine/dist/main.js" ]]; then
  echo "Engine is not built. Run 'pnpm build' first." >&2
  exit 1
fi

if [[ ! -f "$REPO_ROOT/apps/web/.next/BUILD_ID" ]]; then
  echo "Dashboard is not built. Run 'pnpm build' first." >&2
  exit 1
fi

if [[ ! -f "$REPO_ROOT/.env" ]]; then
  echo "No .env found. Copy .env.example to .env first." >&2
  exit 1
fi

mkdir -p "$AGENTS" "$REPO_ROOT/logs" "$REPO_ROOT/data"

# The engine loads .env itself (Node's built-in loader), so this wrapper only
# needs to put it in the right working directory. Deliberately NOT sourcing
# .env here: shell sourcing mangles the quoted PEM private key.
cat > "$REPO_ROOT/scripts/run-engine.sh" <<'WRAPPER'
#!/usr/bin/env bash
set -euo pipefail
cd "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
exec node apps/engine/dist/main.js
WRAPPER
chmod +x "$REPO_ROOT/scripts/run-engine.sh"

# The dashboard runs Next's own binary rather than `pnpm dashboard`, so launchd
# needs only node on PATH. Same host and port as `pnpm dashboard`: it answers
# only on this machine.
cat > "$REPO_ROOT/scripts/run-dashboard.sh" <<'WRAPPER'
#!/usr/bin/env bash
set -euo pipefail
cd "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/apps/web"
exec node node_modules/next/dist/bin/next start -H 127.0.0.1 -p 3000
WRAPPER
chmod +x "$REPO_ROOT/scripts/run-dashboard.sh"

# write_plist LABEL WRAPPER LOGNAME
write_plist() {
  local label="$1" wrapper="$2" logname="$3"
  cat > "$AGENTS/$label.plist" <<PLISTEOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$label</string>

  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>$REPO_ROOT/scripts/$wrapper</string>
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

  <!-- Restart if it exits. Safe for the engine: startup reconciles against the
       exchange, and the kill switch is a file, so a restart cannot lose a halt
       or duplicate a position. The dashboard holds no state at all. -->
  <key>KeepAlive</key>
  <true/>

  <!-- Don't hammer Coinbase (or the CPU) if it is crash-looping on a config error. -->
  <key>ThrottleInterval</key>
  <integer>30</integer>

  <key>StandardOutPath</key>
  <string>$REPO_ROOT/logs/$logname.log</string>
  <key>StandardErrorPath</key>
  <string>$REPO_ROOT/logs/$logname.error.log</string>

  <key>ProcessType</key>
  <string>Background</string>
</dict>
</plist>
PLISTEOF
  echo "Wrote $AGENTS/$label.plist"
}

write_plist "$ENGINE_LABEL" run-engine.sh engine
write_plist "$DASHBOARD_LABEL" run-dashboard.sh dashboard

echo
echo "Start them:"
echo "  launchctl bootstrap gui/$(id -u) $AGENTS/$ENGINE_LABEL.plist"
echo "  launchctl bootstrap gui/$(id -u) $AGENTS/$DASHBOARD_LABEL.plist     # http://localhost:3000"
echo "Stop them:"
echo "  launchctl bootout gui/$(id -u)/$ENGINE_LABEL"
echo "  launchctl bootout gui/$(id -u)/$DASHBOARD_LABEL"
echo "Reinstalling over running services? Boot them out first, then bootstrap:"
echo "the old load/unload commands fail with a misleading 'Input/output error'."
echo "Check them:  launchctl list | grep cryptomagic"
echo "Restart:     cm restart | cm restart dashboard | cm restart all"
echo "Logs:        tail -f $REPO_ROOT/logs/engine.log | apps/engine/node_modules/.bin/pino-pretty"
echo
echo "If you already ran the engine or dashboard in a terminal, stop those first:"
echo "the services cannot start while ports 4000 and 3000 are taken."
echo
echo "Remember: a sleeping Mac does not manage stops. See docs/RUNBOOK.md."
