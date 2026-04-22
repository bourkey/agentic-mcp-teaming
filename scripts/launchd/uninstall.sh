#!/usr/bin/env bash
# Uninstalls the coordinator launchd agent.
set -euo pipefail

TARGET="$HOME/Library/LaunchAgents/com.sysdig.agentic-mcp-coordinator.plist"

if [[ -f "$TARGET" ]]; then
  launchctl unload "$TARGET" 2>/dev/null || true
  rm "$TARGET"
  echo "removed $TARGET"
else
  echo "no launchd agent installed at $TARGET"
fi
