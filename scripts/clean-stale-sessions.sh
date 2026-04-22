#!/usr/bin/env bash
# Removes session directories whose coordinator.lock PID is no longer alive,
# plus session directories that have no lock at all (abandoned).
# Never touches the currently-active session.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SESSIONS_DIR="$REPO_ROOT/sessions"

if [[ ! -d "$SESSIONS_DIR" ]]; then
  echo "no sessions/ dir; nothing to clean"
  exit 0
fi

removed=0
kept=0
for d in "$SESSIONS_DIR"/*/; do
  [[ -d "$d" ]] || continue
  sid=$(basename "$d")
  lock="$d/coordinator.lock"

  if [[ -f "$lock" ]]; then
    pid=$(sed 's/pid=//' "$lock" 2>/dev/null || echo "")
    if [[ -n "$pid" ]] && ps -p "$pid" > /dev/null 2>&1; then
      echo "  KEEP  $sid (pid=$pid alive)"
      kept=$((kept + 1))
      continue
    fi
    echo "  STALE $sid (pid=${pid:-none} gone) — removing"
  else
    echo "  ABANDONED $sid (no lock) — removing"
  fi

  rm -rf "$d"
  removed=$((removed + 1))
done

echo ""
echo "removed $removed session dir(s); kept $kept active"
