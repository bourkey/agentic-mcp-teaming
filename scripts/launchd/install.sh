#!/usr/bin/env bash
# Installs the coordinator as a user-level launchd agent on macOS.
# Safe to re-run: unloads any prior version before loading the new one.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TEMPLATE="$REPO_ROOT/scripts/launchd/com.sysdig.agentic-mcp-coordinator.plist.example"
TARGET="$HOME/Library/LaunchAgents/com.sysdig.agentic-mcp-coordinator.plist"
NODE_BIN="$(command -v node || true)"

if [[ -z "$NODE_BIN" ]]; then
  echo "error: node not found on PATH. Install node first (or activate your nvm version)." >&2
  exit 1
fi

if [[ ! -f "$REPO_ROOT/dist/index.js" ]]; then
  echo "error: $REPO_ROOT/dist/index.js not found. Run 'npm run build' first." >&2
  exit 1
fi

mkdir -p "$(dirname "$TARGET")"
mkdir -p "$HOME/Library/Logs"

# Render the template
sed -e "s#__NODE_PATH__#$NODE_BIN#g" \
    -e "s#__PROJECT_ROOT__#$REPO_ROOT#g" \
    -e "s#__HOME__#$HOME#g" \
    "$TEMPLATE" > "$TARGET"

# Unload any prior instance
launchctl unload "$TARGET" 2>/dev/null || true

# Load + start
launchctl load "$TARGET"

echo "installed $TARGET"
echo "logs: tail -f $HOME/Library/Logs/agentic-mcp-coordinator.log"
echo "status: launchctl list | grep agentic-mcp-coordinator"
echo "stop: launchctl unload $TARGET"
