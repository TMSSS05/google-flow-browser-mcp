#!/usr/bin/env bash
set -euo pipefail
IFS=$'\n\t'

# Start Chrome with configured Google profile and CDP debugging
# Edit the variables below to match your setup, then run BEFORE the MCP server

CHROME="/opt/google/chrome/chrome"
USER_DATA_DIR="$HOME/.config/google-chrome"
PROFILE="Profile 3"
CDP_PORT=9222

log()  { echo "[$(date '+%Y-%m-%dT%H:%M:%S')] INFO  $*" >&2; }
warn() { echo "[$(date '+%Y-%m-%dT%H:%M:%S')] WARN  $*" >&2; }
die()  { echo "[$(date '+%Y-%m-%dT%H:%M:%S')] ERROR $*" >&2; exit 1; }

command -v "$CHROME" >/dev/null 2>&1 || die "Chrome not found at $CHROME"

if lsof -i :$CDP_PORT >/dev/null 2>&1; then
  warn "CDP port $CDP_PORT already in use — checking if it's our Chrome..."
  CURL_RESULT=$(curl -s http://localhost:$CDP_PORT/json/version 2>/dev/null || echo "")
  if [[ -n "$CURL_RESULT" ]]; then
    log "Chrome already running on CDP port $CDP_PORT"
    exit 0
  else
    warn "Port $CDP_PORT is occupied but not responding to CDP. Attempting to kill..."
    fuser -k "${CDP_PORT}/tcp" 2>/dev/null || true
    sleep 2
  fi
fi

log "Launching Chrome with profile $PROFILE on CDP port $CDP_PORT"
"$CHROME" \
  --user-data-dir="$USER_DATA_DIR" \
  --profile-directory="$PROFILE" \
  --remote-debugging-port="$CDP_PORT" \
  --no-first-run \
  --no-default-browser-check \
  --disable-extensions \
  --disable-sync \
  --disable-features=ChromeWhatsNewUI \
  --disable-background-networking \
  --disable-component-update \
  --disable-sync-preferences \
  &

CHROME_PID=$!
log "Chrome launched (PID: $CHROME_PID)"

for i in $(seq 1 15); do
  if curl -s http://localhost:$CDP_PORT/json/version >/dev/null 2>&1; then
    log "Chrome CDP ready on port $CDP_PORT"
    exit 0
  fi
  sleep 1
done

die "Chrome did not start CDP on port $CDP_PORT within 15 seconds"
