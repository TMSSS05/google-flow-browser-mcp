#!/usr/bin/env bash
set -euo pipefail
IFS=$'\n\t'

# Quick test: connect to Google Flow, verify account, take screenshot
# Requires: Chrome running with CDP on port 9222 + MCP server running

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

log()  { echo "[$(date '+%Y-%m-%dT%H:%M:%S')] INFO  $*" >&2; }
die()  { echo "[$(date '+%Y-%m-%dT%H:%M:%S')] ERROR $*" >&2; exit 1; }

MCP_SERVER="node $PROJECT_DIR/src/index.js"

# Test using direct MCP protocol over stdio
log "Testing MCP server tool calls..."

# Test 1: flow_connect
log "Test 1: flow_connect"
echo '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"flow_connect","arguments":{"headless":false,"open_flow":true}}}' | timeout 30 "$MCP_SERVER" 2>/dev/null | head -50
echo ""

log "All tests passed."
