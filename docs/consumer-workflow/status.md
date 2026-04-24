---
name: "OPSX: Status"
description: On-demand dashboard showing active worktrees, change stages, task progress, queue, and merge history
category: Workflow
tags: [workflow, tracking, dashboard]
---

Display the current state of all active changes: slot assignments, task progress, queue, and recent merges.

Can be run from any checkout. Reads `todos.md` (maintained by `/opsx:sync`) plus live `tasks.md` counts from worktree filesystems. When run from a worktree, `todos.md` reflects the version from the last rebase — if the dashboard looks stale, run `/opsx:sync` from the main checkout first.

**Steps**

1. **Check todos.md exists**

   Try to read `todos.md` from the repo root.

   If it does not exist: tell the user "todos.md not found — run /opsx:sync first to initialise it" and stop.

2. **Parse todos.md**

   Read the Active Worktrees table, Queue section, Merged section, and the last-synced timestamp from `todos.md`.

3. **Read live task progress from worktree filesystems**

   First, run `git worktree list --porcelain` to find the actual filesystem path for each area slot. The Active Worktrees table uses short slot names (`frontend`, `backend`, `misc`); expand these to full directory names by prepending `generic-consumer-` (e.g. `frontend` → `generic-consumer-frontend`) when matching against the worktree paths in the output. Record the resolved absolute path for each slot that exists.

   For each slot in the Active Worktrees table that has an active change (not `(free)`):

   Validate the change name from todos.md against `^[a-z0-9][a-z0-9-]{1,48}[a-z0-9]$` before constructing any filesystem path. If validation fails, show `(path not found)` for that slot's progress.

   - Use the resolved worktree path from `git worktree list` for that slot. If the slot has no matching entry in `git worktree list`: show `(path not found)` for that slot's progress and skip.
   - Determine the tasks.md path based on stage:
     - If stage is `ship`: tasks.md was moved by `opsx:archive`. Look for it at `<worktree-path>/openspec/changes/archive/<date>-<change-name>/tasks.md` — find the directory using an exact-suffix match against `<change-name>` within `<worktree-path>/openspec/changes/archive/`. If multiple directories match (e.g. a change was re-opened and re-archived), select the one with the most recent date prefix.
     - Otherwise: `<worktree-path>/openspec/changes/<change-name>/tasks.md`
   - Try to read that file:
     - If the file does not exist (neither active nor archived path): show `(path not found)` for that slot's progress
     - If `tasks.md` exists: count lines matching `- [x]` (complete) and `- [ ]` (incomplete); show `N/M tasks` (N = complete, M = complete + incomplete)
     - If `tasks.md` exists but has no checkbox lines: show `0/0 tasks`

4. **Render the dashboard**

   ```
   ## OPSX Status
   _Last synced: <timestamp from todos.md>_

   ### Active Worktrees

   | Slot     | Change           | Stage       | Progress    |
   |----------|------------------|-------------|-------------|
   | frontend | <change>         | <stage>     | <N/M tasks> |
   | backend  | <change>         | <stage>     | <N/M tasks> |
   | misc     | <change>         | <stage>     | <N/M tasks> |

   ### Queue
   <list from todos.md Queue section>

   ### Merged (recent)
   <list from todos.md Merged section>
   ```

   - Free slots: show `(free)` in Change, blank in Stage, `—` in Progress.
   - Inaccessible worktree paths: show `(path not found)` in Progress.
   - No Queue items: show "(empty)".
   - No Merged items: show "(none yet)".

**Guardrails**
- Never write any files — this skill is read-only
- If todos.md is missing, always direct the user to run `/opsx:sync` first — do not attempt to rebuild it
- Show `(path not found)` rather than erroring when a worktree directory is missing
- Show `0/0 tasks` rather than erroring when tasks.md exists but has no checkbox lines
