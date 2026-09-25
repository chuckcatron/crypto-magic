#!/usr/bin/env bash
#
# Move the bot's state to another Mac.
#
#   On the old Mac:  ./scripts/migrate.sh export             → ~/crypto-magic-state-<date>.tar.gz
#   On the new Mac:  ./scripts/migrate.sh import <archive>
#
# "State" is everything that is not in git: .env (settings and secrets) and
# data/ (the database, including the paper account, positions, trade history and
# equity curve, plus the kill switch file). Code comes from git; build it fresh
# on the new machine.
#
# Both directions refuse to run while the engine is running. Two engines on one
# account is how orders get doubled, and copying a live database can copy it
# mid-write.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LABEL="com.cryptomagic.engine"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"

die() { echo "✗ $*" >&2; exit 1; }

env_value() {
  [[ -f "$ROOT/.env" ]] || return 0
  grep -E "^[[:space:]]*$1=" "$ROOT/.env" | tail -n 1 | cut -d= -f2- | sed -E 's/[[:space:]]+#.*$//; s/^"(.*)"$/\1/' || true
}

require_engine_stopped() {
  if [[ "$(uname -s)" == "Darwin" ]] && launchctl list 2>/dev/null | grep -q "$LABEL"; then
    die "The engine's launchd service is loaded, and it restarts the engine if stopped any other way.
  Stop it first:  launchctl unload $PLIST"
  fi
  local port
  port="$(env_value PORT)"
  if curl -s -m 2 "http://127.0.0.1:${port:-4000}/api/status" >/dev/null 2>&1; then
    die "An engine is answering on 127.0.0.1:${port:-4000}. Stop it before migrating."
  fi
}

sha256() { if command -v shasum >/dev/null; then shasum -a 256 "$1"; else sha256sum "$1"; fi | cut -d' ' -f1; }

cmd_export() {
  cd "$ROOT"
  [[ -f .env ]] || die "No .env here; nothing to export."
  require_engine_stopped

  local items=(.env)
  [[ -d data ]] && items+=(data)
  [[ "${1:-}" == "--with-logs" && -d logs ]] && items+=(logs)

  local out="$HOME/crypto-magic-state-$(date +%Y%m%d-%H%M).tar.gz"
  umask 077   # the archive holds your API keys
  tar -czf "$out" "${items[@]}"

  echo "✓ Exported ${items[*]} to:"
  echo "    $out"
  echo "  sha256 $(sha256 "$out")"
  echo
  echo "It contains your API keys. Move it by AirDrop or a USB drive, not email or"
  echo "cloud storage, and delete it from both Macs once the import works."
  echo
  echo "Leave the engine STOPPED on this Mac from now on. Two engines on one account"
  echo "double every order, and two dead-man pings hide a dead bot."
}

cmd_import() {
  local archive="${1:-}"
  local force="${2:-}"
  [[ -n "$archive" ]] || die "Usage: $0 import <archive> [--force]"
  [[ -f "$archive" ]] || die "No such file: $archive"
  cd "$ROOT"
  require_engine_stopped

  # Only .env, data/ and logs/ may come out of the archive: no absolute paths,
  # no ../, nothing that could land outside this checkout.
  local unexpected
  unexpected="$(tar -tzf "$archive" | grep -vE '^(\./)?(\.env|data(/.*)?|logs(/.*)?)$' || true)"
  [[ -z "$unexpected" ]] || die "Archive contains unexpected entries; refusing:
$unexpected"

  if [[ -e .env || -e data ]]; then
    [[ "$force" == "--force" ]] || die "This checkout already has .env or data/. Re-run with --force to move them aside first."
    local aside
    aside="$ROOT/.pre-import-$(date +%Y%m%d-%H%M%S)"
    mkdir -p "$aside"
    [[ -e .env ]] && mv .env "$aside/"
    [[ -e data ]] && mv data "$aside/"
    echo "  Moved the existing .env and data/ to $aside"
  fi

  tar -xzf "$archive" -C "$ROOT"
  chmod 600 .env

  echo "✓ Imported state into $ROOT"
  echo
  echo "Next:"
  echo "  1. Edit .env for this machine (for example OLLAMA_MODEL; see docs/SETUP-AND-MIGRATION.md)"
  echo "  2. pnpm install && pnpm build"
  echo "  3. ./scripts/install-launchd.sh && launchctl load $PLIST"
  echo "  4. ./scripts/doctor.sh  and  node scripts/cm.mjs"
}

case "${1:-}" in
  export) shift; cmd_export "$@" ;;
  import) shift; cmd_import "$@" ;;
  *)
    echo "Usage:"
    echo "  $0 export [--with-logs]     on the old Mac"
    echo "  $0 import <archive> [--force]  on the new Mac"
    exit 1
    ;;
esac
