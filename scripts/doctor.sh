#!/usr/bin/env bash
#
# Preflight check: is this Mac ready to run crypto-magic 24/7?
#
#   ./scripts/doctor.sh
#
# Run it after setting up a machine, and again after migrating to a new one.
# It only reads; it changes nothing. Secret values are never printed, only
# whether they are set.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT" || exit 1

LABEL="com.cryptomagic.engine"
fails=0
warns=0

if [[ -t 1 && -z "${NO_COLOR:-}" ]]; then
  G=$'\e[32m'; Y=$'\e[33m'; R=$'\e[31m'; D=$'\e[2m'; N=$'\e[0m'
else
  G=''; Y=''; R=''; D=''; N=''
fi
pass() { printf '%s✓%s %s\n' "$G" "$N" "$1"; }
warn() { printf '%s!%s %s\n' "$Y" "$N" "$1"; [[ -n "${2:-}" ]] && printf '  %s%s%s\n' "$D" "$2" "$N"; warns=$((warns + 1)); }
fail() { printf '%s✗%s %s\n' "$R" "$N" "$1"; [[ -n "${2:-}" ]] && printf '  %s%s%s\n' "$D" "$2" "$N"; fails=$((fails + 1)); }
section() { printf '\n%s\n' "$1"; }

# Last assignment of KEY in .env, quotes stripped. Never echoed for secrets.
env_value() {
  [[ -f .env ]] || return 0
  grep -E "^[[:space:]]*$1=" .env | tail -n 1 | cut -d= -f2- | sed -E 's/^[[:space:]]*//; s/[[:space:]]+#.*$//; s/^"(.*)"$/\1/; s/^'"'"'(.*)'"'"'$/\1/'
}
is_set() { [[ -n "$(env_value "$1")" ]]; }

IS_MAC=false
[[ "$(uname -s)" == "Darwin" ]] && IS_MAC=true

# --- Toolchain ------------------------------------------------------------------
section "Toolchain"
if command -v node >/dev/null 2>&1; then
  major="$(node -p 'process.versions.node.split(".")[0]')"
  if (( major >= 22 )); then pass "Node $(node -v)"; else fail "Node $(node -v) is too old" "Needs 22 or newer: brew install node@22"; fi
else
  fail "Node is not installed" "brew install node@22"
fi
if command -v pnpm >/dev/null 2>&1; then pass "pnpm $(pnpm -v)"; else fail "pnpm is not installed" "brew install pnpm"; fi
[[ -d node_modules ]] && pass "Dependencies installed" || fail "Dependencies not installed" "pnpm install"
[[ -f apps/engine/dist/main.js ]] && pass "Engine built" || fail "Engine not built" "pnpm build"
[[ -d apps/web/.next ]] && pass "Dashboard built" || warn "Dashboard not built" "pnpm build (only needed for the web dashboard)"

# --- Configuration --------------------------------------------------------------
section "Configuration (.env)"
if [[ ! -f .env ]]; then
  fail ".env is missing" "cp .env.example .env"
else
  if $IS_MAC; then perms="$(stat -f %Lp .env)"; else perms="$(stat -c %a .env)"; fi
  if [[ "$perms" == "600" || "$perms" == "400" ]]; then pass ".env is private (mode $perms)"; else warn ".env is readable by other users (mode $perms)" "chmod 600 .env"; fi

  mode="$(env_value TRADING_MODE)"; mode="${mode:-paper}"
  if [[ "$mode" == "live" ]]; then warn "TRADING_MODE=live — real money" "Paper-trade on this machine first"; else pass "TRADING_MODE=paper"; fi

  if is_set NTFY_TOPIC || is_set DISCORD_WEBHOOK_URL || { is_set TELEGRAM_BOT_TOKEN && is_set TELEGRAM_CHAT_ID; }; then
    pass "An alert channel is configured"
  else
    fail "No alert channel configured" "Set NTFY_TOPIC, DISCORD_WEBHOOK_URL or the Telegram pair (docs/RUNBOOK.md)"
  fi
  is_set DEADMAN_PING_URL && pass "Dead-man's switch is configured" \
    || warn "Dead-man's switch not configured" "Set DEADMAN_PING_URL (docs/REMOTE-ACCESS.md, step 4)"

  for key in DATABASE_PATH KILL_SWITCH_FILE; do
    value="$(env_value "$key")"
    if [[ "$value" == /* ]]; then
      warn "$key is an absolute path" "Relative paths (the default) move with the repo; absolute ones break on a new Mac"
    fi
  done
fi

# --- Engine ---------------------------------------------------------------------
section "Engine"
port="$(env_value PORT)"; port="${port:-4000}"
if $IS_MAC; then
  if [[ -f "$HOME/Library/LaunchAgents/$LABEL.plist" ]]; then
    plist_root="$(grep -A1 WorkingDirectory "$HOME/Library/LaunchAgents/$LABEL.plist" | tail -n 1 | sed -E 's/.*<string>(.*)<\/string>.*/\1/')"
    if [[ "$plist_root" == "$ROOT" ]]; then pass "launchd service installed for this checkout"
    else fail "launchd service points at a different checkout: $plist_root" "Re-run ./scripts/install-launchd.sh from here"; fi
    if launchctl list 2>/dev/null | grep -q "$LABEL"; then pass "launchd service loaded"
    else warn "launchd service not loaded" "launchctl load ~/Library/LaunchAgents/$LABEL.plist"; fi
  else
    warn "launchd service not installed" "./scripts/install-launchd.sh (starts at login, restarts on crash)"
  fi
fi
if status="$(curl -s -m 3 "http://127.0.0.1:$port/api/status")" && [[ -n "$status" ]]; then
  pass "Engine answering on 127.0.0.1:$port"
  if grep -q '"killSwitchEngaged":true' <<<"$status"; then warn "Kill switch is ENGAGED" "cm release, once you know why"; fi
  if grep -q '"lastTickCompletedAt":null' <<<"$status"; then warn "Trading loop has not completed a pass yet" "Check: cm logs"; fi
else
  warn "Engine not answering on 127.0.0.1:$port" "Not running, or still starting: cm logs"
fi

# --- Staying awake --------------------------------------------------------------
if $IS_MAC; then
  section "Staying awake"
  sleep_min="$(pmset -g 2>/dev/null | awk '$1 == "sleep" { print $2; exit }')"
  if [[ "$sleep_min" == "0" ]]; then pass "System sleep disabled"
  else warn "System sleep is set to ${sleep_min:-?} min" "Keep Amphetamine running, or: sudo pmset -c sleep 0 (on power adapter only)"; fi
  if pmset -g batt 2>/dev/null | grep -q "AC Power"; then pass "On power adapter"
  elif pmset -g batt 2>/dev/null | grep -q "Battery Power"; then fail "Running on battery" "Plug in; a laptop on battery will sleep and stop managing stops"; fi
  if command -v fdesetup >/dev/null 2>&1 && fdesetup status 2>/dev/null | grep -q "On"; then
    pass "FileVault on (after a power cut, someone must unlock the Mac before the bot restarts)"
  else
    warn "FileVault is off" "Your API keys are on this disk. Turn it on in System Settings → Privacy & Security"
  fi
fi

# --- Optional services ----------------------------------------------------------
section "Optional"
if [[ "$(env_value LLM_ENABLED)" == "true" ]]; then
  model="$(env_value OLLAMA_MODEL)"; model="${model:-llama3.1:8b}"
  base="$(env_value OLLAMA_BASE_URL)"; base="${base:-http://127.0.0.1:11434}"
  if tags="$(curl -s -m 3 "$base/api/tags")" && [[ -n "$tags" ]]; then
    if grep -q "\"$model\"" <<<"$tags"; then pass "Ollama running with $model"
    else fail "Ollama is running but $model is not pulled" "ollama pull $model"; fi
  else
    fail "LLM_ENABLED=true but Ollama is not answering at $base" "Open the Ollama app, or set LLM_ENABLED=false"
  fi
else
  pass "Local model disabled (LLM_ENABLED=false)"
fi
if command -v tailscale >/dev/null 2>&1 || [[ -d /Applications/Tailscale.app ]]; then pass "Tailscale installed"
else warn "Tailscale not installed" "Needed for phone access: docs/REMOTE-ACCESS.md"; fi

free_gb="$(df -Pk "$ROOT" | awk 'NR == 2 { printf "%d", $4 / 1048576 }')"
if (( free_gb >= 20 )); then pass "${free_gb} GB free disk"; else warn "Only ${free_gb} GB free disk" "The database and logs grow; models need 5–20 GB each"; fi

# --- Summary --------------------------------------------------------------------
printf '\n'
if (( fails > 0 )); then
  printf '%s%d problem(s)%s and %d warning(s). Fix the ✗ lines first.\n' "$R" "$fails" "$N" "$warns"
  exit 1
fi
printf '%sReady.%s %d warning(s).\n' "$G" "$N" "$warns"
