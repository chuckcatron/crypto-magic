#!/usr/bin/env bash
#
# Install crypto-magic as a launchd agent so it starts at login and restarts if
# it dies. macOS only. Run from the repo root: ./scripts/install-launchd.sh
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LABEL="com.cryptomagic.engine"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"

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

if [[ ! -f "$REPO_ROOT/.env" ]]; then
  echo "No .env found. Copy .env.example to .env first." >&2
  exit 1
fi

mkdir -p "$HOME/Library/LaunchAgents" "$REPO_ROOT/logs" "$REPO_ROOT/data"

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

cat > "$PLIST" <<PLISTEOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$LABEL</string>

  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>$REPO_ROOT/scripts/run-engine.sh</string>
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

  <!-- Restart if it exits. Safe: startup reconciles against the exchange, and
       the kill switch is a file, so a restart cannot lose a halt or duplicate
       a position. -->
  <key>KeepAlive</key>
  <true/>

  <!-- Don't hammer Coinbase if it is crash-looping on a config error. -->
  <key>ThrottleInterval</key>
  <integer>30</integer>

  <key>StandardOutPath</key>
  <string>$REPO_ROOT/logs/engine.log</string>
  <key>StandardErrorPath</key>
  <string>$REPO_ROOT/logs/engine.error.log</string>

  <key>ProcessType</key>
  <string>Background</string>
</dict>
</plist>
PLISTEOF

echo "Wrote $PLIST"
echo
echo "Start it:   launchctl load  $PLIST"
echo "Stop it:    launchctl unload $PLIST"
echo "Check it:   launchctl list | grep cryptomagic"
echo "Logs:       tail -f $REPO_ROOT/logs/engine.log | npx pino-pretty"
echo
echo "Remember: a sleeping Mac does not manage stops. See docs/RUNBOOK.md."
