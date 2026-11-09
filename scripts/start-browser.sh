#!/usr/bin/env bash
set -euo pipefail
IFS=$'\n\t'

# Start Chrome or Edge with the configured Google profile and CDP debugging.
# Settings come from config/flow.config.json (browserPath, chromeUserDataDir,
# chromeProfile, cdpPort). Run BEFORE the MCP server.
#
# Chrome/Edge 136+ refuse remote debugging on the default user data dir, so the
# profile is copied into a temp dir first (cookies/login carry over).

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

log()  { echo "[$(date '+%Y-%m-%dT%H:%M:%S')] INFO  $*" >&2; }
warn() { echo "[$(date '+%Y-%m-%dT%H:%M:%S')] WARN  $*" >&2; }
die()  { echo "[$(date '+%Y-%m-%dT%H:%M:%S')] ERROR $*" >&2; exit 1; }

command -v node >/dev/null 2>&1 || die "Node.js is required"

# Read a key from flow.config.json (empty string if missing)
cfg() {
  node -e "try{const c=require(process.argv[1]);const v=c[process.argv[2]];process.stdout.write(v==null?'':String(v))}catch{}" \
    "$PROJECT_DIR/config/flow.config.json" "$1"
}

# Convert Windows paths to POSIX under Git Bash/MSYS (no-op elsewhere)
to_posix() { if command -v cygpath >/dev/null 2>&1; then cygpath -u "$1"; else echo "$1"; fi; }
to_native() { if command -v cygpath >/dev/null 2>&1; then cygpath -w "$1"; else echo "$1"; fi; }

BROWSER="$(cfg browserPath)"
USER_DATA_DIR="$(cfg chromeUserDataDir)"
PROFILE="$(cfg chromeProfile)"
CDP_PORT="$(cfg cdpPort)"
PROFILE="${PROFILE:-Profile 3}"
CDP_PORT="${CDP_PORT:-9222}"

if [[ -z "$BROWSER" ]]; then
  for candidate in \
    "/c/Program Files (x86)/Microsoft/Edge/Application/msedge.exe" \
    "/c/Program Files/Microsoft/Edge/Application/msedge.exe" \
    "/c/Program Files/Google/Chrome/Application/chrome.exe" \
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge" \
    "/opt/google/chrome/chrome" \
    "/usr/bin/microsoft-edge"; do
    if [[ -x "$candidate" ]]; then BROWSER="$candidate"; break; fi
  done
fi
[[ -n "$BROWSER" ]] || die "No Chrome/Edge found. Set \"browserPath\" in config/flow.config.json"
BROWSER="$(to_posix "$BROWSER")"
[[ -x "$BROWSER" ]] || die "Browser not found at $BROWSER"

[[ -n "$USER_DATA_DIR" ]] || die "Set \"chromeUserDataDir\" in config/flow.config.json"
USER_DATA_DIR="$(to_posix "$USER_DATA_DIR")"
[[ -d "$USER_DATA_DIR/$PROFILE" ]] || die "Profile not found: $USER_DATA_DIR/$PROFILE"

if curl -s "http://localhost:$CDP_PORT/json/version" >/dev/null 2>&1; then
  log "Browser already running on CDP port $CDP_PORT"
  exit 0
fi

TEMP_DIR="${TMPDIR:-/tmp}/chrome-kiara-cdp-$(date +%s)"
mkdir -p "$TEMP_DIR"
log "Copying profile \"$PROFILE\" to $TEMP_DIR (close the browser first if this fails on locked files)"
cp -r "$USER_DATA_DIR/$PROFILE" "$TEMP_DIR/$PROFILE"
rm -rf "$TEMP_DIR/$PROFILE/Cache" "$TEMP_DIR/$PROFILE/Code Cache" "$TEMP_DIR/$PROFILE/GPUCache" "$TEMP_DIR/$PROFILE/Service Worker"
[[ -f "$USER_DATA_DIR/Local State" ]] && cp "$USER_DATA_DIR/Local State" "$TEMP_DIR/Local State"

log "Launching $BROWSER with profile $PROFILE on CDP port $CDP_PORT"
"$BROWSER" \
  --user-data-dir="$(to_native "$TEMP_DIR")" \
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
  >/dev/null 2>&1 &

BROWSER_PID=$!
log "Browser launched (PID: $BROWSER_PID)"

for i in $(seq 1 15); do
  if curl -s "http://localhost:$CDP_PORT/json/version" >/dev/null 2>&1; then
    log "Browser CDP ready on port $CDP_PORT"
    exit 0
  fi
  sleep 1
done

die "Browser did not start CDP on port $CDP_PORT within 15 seconds"
