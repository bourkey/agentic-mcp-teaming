---
name: "OPSX: Ship"
description: Push the current worktree branch and open a PR to main
category: Workflow
tags: [workflow, git, pr]
---

Push the current feature branch and open a pull request to `main`.

Run this from the worktree after `/opsx:archive` completes.

**Steps**

0. **Verify not on main — unconditional first action**

   ```bash
   git branch --show-current
   ```

   - If the result is `main`: **stop immediately**. Print "`/opsx:ship` runs from a worktree, not the main checkout. Switch to your area's tmux pane (`cd ../generic-consumer-<area> && claude`) and re-run." Do not execute any further steps.
   - If the result is an empty string (detached HEAD): **stop immediately**. Print "Check out a named feature branch before running `/opsx:ship` — detached HEAD has no branch to push." Do not execute any further steps.
   - Otherwise: proceed.

   This guard MUST fire before any file read or git mutation.

1. **Confirm current branch has no uncommitted changes**

   ```bash
   git status --short
   ```

   If there are uncommitted changes: list them and ask the user to commit or discard before proceeding.

2. **Write stage: ship to .openspec.yaml**

   Derive the change name from the current branch (strip `feat/` prefix).
   Validate the derived change name against `^[a-z0-9][a-z0-9-]{1,48}[a-z0-9]$`. If validation fails: stop and tell the user the branch name does not follow the required change name format.

   Locate the archived copy using an exact-suffix match:

   ```bash
   ls openspec/changes/archive/ | grep -E "^[0-9]{4}-[0-9]{2}-[0-9]{2}-<change-name>$"
   ```

   If multiple directories match (e.g. a change was re-opened and re-archived), select the one with the most recent date prefix. Record this as `<resolved-archive-dir>` — reuse it in step 4 instead of re-running the lookup.

   The archived path is `openspec/changes/archive/<resolved-archive-dir>/.openspec.yaml`.

   If no archived copy is found: stop and tell the user "No archived copy found — run opsx:archive before opsx:ship".

   If found: read the file, find any existing `stage:` line and replace it, or append `stage: ship` if no `stage:` line exists. Write the file back atomically (read → modify in memory → write full file). Do not append a duplicate.

   Stage and commit the change:

   ```bash
   git add openspec/changes/archive/<date>-<change-name>/.openspec.yaml
   git commit -m "chore(opsx): mark <change-name> stage: ship"
   ```

3. **Push the branch**

   ```bash
   git push -u origin $(git branch --show-current)
   ```

4. **Find the archived change for this branch**

   Use the `<resolved-archive-dir>` already located in step 2 — do not re-run the archive lookup.

   Read `openspec/changes/archive/<resolved-archive-dir>/proposal.md` if it exists.
   Fall back to the branch name as the PR title and an empty body if not found.

5. **Open the PR**

   ```bash
   gh pr create \
     --title "<branch-name>" \
     --label "enhancement" \
     --body "$(cat openspec/changes/archive/<resolved-archive-dir>/proposal.md)"
   ```

   Output the PR URL.

6. **Display next steps**

   ```
   ## PR Open

   **Change:** <change-name>
   **Branch:** feat/<change-name>
   **PR:** <url>

   ---
   Next step — switch to your main tmux pane and run:
   /opsx:merge <number>
   ```

7. **Emit `ship-ready` peer-bus event (optional; silently skipped when the bus is off)**

   After the PR is confirmed open on GitHub. See `openspec/specs/portal-opsx-peer-bus/spec.md` (post-archive) for the normative contract.

   Gate: ALL of the following must be true, otherwise SKIP silently:
   - `$COORDINATOR_SESSION_NAME` is set,
   - `$PEER_BUS_DISABLED` is NOT equal to `1`,
   - the `coordinator` MCP tool is available.

   If `sessionToken` is not in working context, first call `register_session({ name: $COORDINATOR_SESSION_NAME, paneToken: $COORDINATOR_SESSION_TOKEN })` and cache the returned `sessionToken`.

   ```
   send_message({
     sessionToken: <sessionToken from context>,
     to: "claude-main",
     kind: "workflow-event",
     body: {
       event: "ship-ready",
       change: "<change-name>",
       pr: <pr-number as integer, not string>,
       area: "<area>"                # the area of the current worktree (frontend/backend/misc)
     }
   })
   ```

   Body-field hygiene: only the four fields above. Do NOT include PR URL, PR title, or any other free-text. Same error-handling as the `worktree-ready` emit: `invalid_session_token` → startup-skill recovery; any other named or transport error → one log per session (`peer-bus: <error> for ship-ready`) and continue.

**Guardrails**
- Never run from `main` — check the branch first
- Never push if there are uncommitted changes — surface them first
- Use the proposal as the PR body if available — it's already well-written
- Do not merge — merging happens from the main pane after CI passes
