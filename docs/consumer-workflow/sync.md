---
name: "OPSX: Sync"
description: Reads GitHub issues and git state to produce a normalised todos.md tracking file
category: Workflow
tags: [workflow, git, github, tracking]
---

Rebuild `todos.md` from GitHub issues, open PRs, and active worktrees.

Run this from the **main checkout** (`generic-consumer/`).

**Steps**

1. **Verify running from main checkout**

   ```bash
   git branch --show-current
   ```

   If the current branch is not `main`: print "sync must be run from the main checkout" and stop. Do not write or commit anything.

2. **Check gh is available**

   ```bash
   gh --version
   ```

   If `gh` is not available or not authenticated: warn the user and stop.

3. **Fetch data from GitHub and git**

   Run all four in parallel:

   ```bash
   gh issue list --label enhancement --state open --json number,title,url --limit 100
   gh issue list --label enhancement --state closed --json number,title,closedAt,url --limit 20
   gh pr list --state open --json number,headRefName,baseRefName,title,url
   git worktree list --porcelain
   ```

4. **Identify active area slots**

   From `git worktree list` output, identify only worktrees whose directory name is exactly one of: `generic-consumer-frontend`, `generic-consumer-backend`, `generic-consumer-misc`. Record the branch checked out in each slot. All other worktrees (including the main checkout and any conduit/CI workspaces) are ignored.

5. **Extract change names from issue titles**

   For each issue, extract the change name using this algorithm:
   - If the title contains ` — ` (space, U+2014 em dash, space): take the text before it
   - Otherwise: use the full title
   - Strip any leading `feat: ` prefix
   - Validate the result against `^[a-z0-9][a-z0-9-]{1,48}[a-z0-9]$`
   - If validation fails: skip this issue with a warning and continue to the next

6. **Derive stage for each change**

   For each issue's change name, apply the following precedence (first match wins):
   - `merged` — issue is in closed state (overrides all other conditions)
   - `ship` — issue is open AND a PR exists with head branch `feat/<change-name>` AND that PR targets `main`
   - `in-progress` — issue is open AND `feat/<change-name>` is checked out in one of the three area slots AND no open PR targeting `main` exists
   - `queued` — issue is open, no matching active worktree, no open PR targeting `main`

   For `ship` changes: note the PR number (for stage derivation only — not written to todos.md). For `in-progress` changes: record the slot area.

7. **Build todos.md content and check for changes**

   Construct the new todos.md body in memory (do not write to disk yet). Escape `|` as `\|` and backticks as `` \` `` in any issue title before writing to table cells. The format is:

   ```markdown
   # todos.md

   _Last synced: <ISO-8601 datetime with UTC offset, e.g. 2026-04-16T14:30:00+10:00>_

   ## Active Worktrees

   | Slot | Change | Stage |
   |------|--------|-------|
   | frontend | <change-name or (free)> | <stage or blank> |
   | backend  | <change-name or (free)> | <stage or blank> |
   | misc     | <change-name or (free)> | <stage or blank> |

   ## Queue

   Changes open but not yet in a worktree:

   - <change-name> (#<issue-number>)

   ## Merged

   Recently closed changes (last 20):

   - <change-name> — closed <closedAt date> (#<issue-number>)
   ```

   - Active Worktrees: list all three slots. For a slot with an active change, show the change name and its stage (`in-progress` or `ship`). For a free slot, show `(free)` with a blank stage. Changes at stage `in-progress` or `ship` appear here and nowhere else.
   - Queue: list all `queued` changes, sorted by issue number descending (newest first).
   - Merged: list all `merged` changes from the closed issues fetch, sorted by `closedAt` descending (newest first).

   **Compare non-timestamp content before writing:**

   Determine whether the substantive content has changed by comparing without the timestamp line:

   - If `todos.md` does not yet exist: treat as changed (first-ever run). Proceed to write and commit.
   - If `todos.md` exists but is **not tracked in git** (check: `git ls-files --error-unmatch todos.md 2>/dev/null` exits non-zero): treat as changed — a previous sync was interrupted before committing. Proceed to write and commit.
   - If `todos.md` exists and **is tracked**: read it, remove the line starting with `_Last synced:`, do the same for the new content, and compare the remainder.

   If the non-timestamp content is **identical** (and the file is tracked): report "todos.md unchanged, no commit needed" and stop. Do not write anything.

   If the non-timestamp content **differs**: write the full new content (including fresh timestamp) to `todos.md`, then proceed to step 8.

8. **Commit**

   Stage `todos.md` and verify nothing else is staged before committing:

   ```bash
   git add todos.md
   git diff --cached --name-only
   ```

   If any file other than `todos.md` appears: warn the user ("sync found other staged files — commit or unstage them before running sync"). Clean up `todos.md` before exiting:
   - If previously tracked (`git ls-files --error-unmatch todos.md` exits 0): run `git restore --staged todos.md` to unstage, then `git checkout -- todos.md` to restore the committed content to disk.
   - If first-ever run (not previously tracked): run `git rm --cached todos.md` to remove from index, then delete the `todos.md` file from disk.
   Exit without committing.

   If only `todos.md` is staged:
   ```bash
   git commit -m "chore(opsx): sync todos.md from GitHub issues"
   ```

   If the commit **succeeds**: report the commit hash and "todos.md updated".

   **Emit `todos-updated` peer-bus event (optional; silently skipped when the bus is off)**

   After commit succeeds, fan the event out to every active pane. See `openspec/specs/portal-opsx-peer-bus/spec.md` (post-archive) for the normative contract.

   Gate: ALL of the following must be true, otherwise SKIP silently:
   - `$COORDINATOR_SESSION_NAME` is set (sync runs from main so the launcher set it),
   - `$PEER_BUS_DISABLED` is NOT equal to `1`,
   - the `coordinator` MCP tool is available.

   **Capture once** — before any emit:
   ```bash
   BUS_COMMIT_SHA=$(git rev-parse HEAD)
   ```
   Every emit this invocation makes uses `$BUS_COMMIT_SHA` — do NOT re-run `git rev-parse` per recipient.

   **Determine active panes** — probe sibling directories:
   ```bash
   for cand in main ../generic-consumer-frontend ../generic-consumer-backend ../generic-consumer-misc; do
     # "main" is always active (the pane we're running in)
     # for siblings, include only when the directory exists
     ...
   done
   ```

   **For each active pane** (always `main`; plus any of `frontend`/`backend`/`misc` whose `../generic-consumer-<area>/` sibling exists):

   ```
   send_message({
     sessionToken: <cached session token>,
     to: "claude:<pane-name>",
     kind: "workflow-event",
     body: {
       event: "todos-updated",
       commitSha: "<BUS_COMMIT_SHA>"      # 40-char lowercase hex, captured once
     }
   })
   ```

   Body-field hygiene: only `event` and `commitSha`. Do NOT include `todos.md` content, issue titles, or any free-text.

   **Error handling (per emit).** `invalid_session_token` → startup-skill recovery. Any other named error (`recipient_not_registered`, `mailbox_full`, ...) or transport-level failure → log ONCE per session as `peer-bus: <error> for todos-updated/<pane>` and CONTINUE the fan-out loop — do NOT abort remaining emits. The "todos.md updated" output is unchanged by any emit outcome.

   If the commit **fails**:
   - First, unstage `todos.md` to clean the index:
     ```bash
     git restore --staged todos.md 2>/dev/null || git rm --cached todos.md 2>/dev/null
     ```
   - Then check whether `todos.md` had a previously committed version:
     ```bash
     git ls-files --error-unmatch todos.md 2>/dev/null
     ```
     - If previously committed: `git checkout -- todos.md` to restore the committed content to disk
     - If first-ever run (not previously tracked): delete the `todos.md` file from disk
   - Report the git error to the user and exit.

**Guardrails**
- Abort immediately if not on `main` branch — do not write anything
- Abort if `gh` is unavailable or not authenticated
- Skip (with warning) any issue whose title does not yield a valid change-name slug
- Never write to any file other than `todos.md`
- Escape `|` and backtick characters in issue titles before writing to table cells
