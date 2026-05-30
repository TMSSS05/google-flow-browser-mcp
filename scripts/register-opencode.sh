#!/usr/bin/env bash
set -euo pipefail
IFS=$'\n\t'

# Register the Google Flow Browser MCP in OpenCode config
# Makes backup before modifying

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
OPERCODE_CONFIG="$HOME/.config/opencode/opencode.json"
MCP_SERVER_CMD="node $PROJECT_DIR/src/index.js"

log()  { echo "[$(date '+%Y-%m-%dT%H:%M:%S')] INFO  $*" >&2; }
warn() { echo "[$(date '+%Y-%m-%dT%H:%M:%S')] WARN  $*" >&2; }
die()  { echo "[$(date '+%Y-%m-%dT%H:%M:%S')] ERROR $*" >&2; exit 1; }

command -v jq >/dev/null 2>&1 || die "jq is required"
[[ -f "$OPERCODE_CONFIG" ]] || die "OpenCode config not found: $OPERCODE_CONFIG"

BACKUP="${OPERCODE_CONFIG}.backup-$(date +%Y%m%d_%H%M%S)"
cp "$OPERCODE_CONFIG" "$BACKUP"
log "Backup saved: $BACKUP"

if jq -e '.mcpServers | has("google-flow-browser")' "$OPERCODE_CONFIG" >/dev/null 2>&1; then
  warn "google-flow-browser MCP already registered. Skipping."
  exit 0
fi

jq --arg cmd "$MCP_SERVER_CMD" \
  '.mcpServers["google-flow-browser"] = { "command": "node", "args": ["'"$PROJECT_DIR/src/index.js"'"], "disabled": false, "autoApprove": [] }' \
  "$OPERCODE_CONFIG" > /tmp/opencode-tmp.json

mv /tmp/opencode-tmp.json "$OPERCODE_CONFIG"
log "google-flow-browser MCP registered in OpenCode config"
log "Server command: $MCP_SERVER_CMD"
log ""
log "IMPORTANT: Restart OpenCode for the changes to take effect."
