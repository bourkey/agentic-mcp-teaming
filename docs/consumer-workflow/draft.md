---
name: "OPSX: Draft"
description: Capture a new change idea from a worktree session as a draft for the main pane to pick up
category: Workflow
tags: [workflow, opsx, draft, worktree]
---

Capture a new change idea discovered during a worktree session and write it to `openspec/drafts/<name>.md` as a filesystem-only handoff. The main pane's `/opsx:worktree <name>` picks up the draft and seeds `/opsx:propose` without requiring the user to re-describe the change.

Run this from a **worktree** (never main). Drafts are filesystem-only — they are NOT committed to git.

**Input**: Optionally specify a change name (e.g., `/opsx:draft portal-tenant-idor-fix`). If omitted, collect it via AskUserQuestion.

**Steps**

0. **Branch guard — unconditional first action**

   ```bash
   git branch --show-current
   ```

   Evaluate the result before anything else — no user input, no path construction, no argument parsing:

   - If the result is `main`: **stop immediately**. Print "`/opsx:draft` runs from a worktree. You are on `main` — switch to the worktree pane or run `/opsx:propose` directly instead." Do not continue.
   - If the result is an empty string (detached HEAD): **stop immediately**. Print "Check out a named feature branch before running `/opsx:draft` — the `drafted-from` field requires a valid branch." Do not continue.
   - Otherwise: proceed.

1. **Resolve the change name**

   If a name was provided as an argument, use it. Otherwise use AskUserQuestion to collect the change name.

2. **Validate the change name**

   The name MUST match `^[a-z0-9][a-z0-9-]{0,62}$` (1–63 characters total: one leading `[a-z0-9]` plus up to 62 `[a-z0-9-]` characters).

   If validation fails, stop with a clear error: "Invalid change name `<name>` — names must match `^[a-z0-9][a-z0-9-]{0,62}$` (lowercase alphanumerics and hyphens, 1–63 characters, leading character alphanumeric)." Do not write any file.

3. **Collect context from the user**

   Use AskUserQuestion to collect:

   - `area` — one of `frontend`, `backend`, `misc`. If the user supplies any other value, reject and re-prompt. Do not proceed with an invalid area.
   - `priority` — one of `low`, `medium`, `high`, `critical`. If the user supplies any other value, reject and re-prompt.
   - `why` — a one-sentence description of why this change is needed.
   - `what_changes` — a brief list of the key changes this will make (bullet points are fine).

4. **Check for existing draft at the same path**

   ```bash
   ls openspec/drafts/<name>.md 2>/dev/null
   ```

   If the file already exists:
   - Read and display its contents to the user.
   - Use AskUserQuestion to ask whether to overwrite or abort.
   - If the user declines overwrite, stop without modifying the existing file.
   - If the user confirms overwrite, proceed.

5. **Create the drafts directory if absent**

   ```bash
   mkdir -p openspec/drafts
   ```

6. **Write the draft atomically**

   Build the draft content with YAML frontmatter followed by `## Why` and `## What Changes` sections:

   ```markdown
   ---
   name: <name>
   area: <area>
   priority: <priority>
   drafted-from: <current-branch>
   ---

   ## Why

   <why>

   ## What Changes

   <what_changes>
   ```

   Where `<current-branch>` is the output of `git branch --show-current` (already known to be non-empty and non-main from the branch guard).

   Write atomically: write to a temp path inside the same directory, then rename into place. Use the positional template form, which is portable across BSD (macOS) and GNU `mktemp` — `mktemp -p DIR` is GNU-only and fails on macOS where the project runs.

   ```bash
   TMP=$(mktemp openspec/drafts/.draft.XXXXXX)
   # write content to "$TMP" (use the Write tool with the absolute path)
   mv "$TMP" openspec/drafts/<name>.md
   ```

   The `mv` (rename) within the same filesystem is atomic on POSIX — readers either see the old file (or absence) or the complete new file, never a partial write.

7. **Confirm**

   Display what was written and remind the user drafts are not committed to git:

   ```
   ## Draft Written

   **Name:** <name>
   **Area:** <area>
   **Priority:** <priority>
   **File:** openspec/drafts/<name>.md

   Drafts are filesystem-only (gitignored) and will not appear in `git status`.

   ---
   Next step — switch to your main tmux pane and run:
   /opsx:worktree <name>
   ```

**Guardrails**
- Never run from `main` — the branch guard is the unconditional first action
- Never run from detached HEAD — `drafted-from` requires a valid branch
- Never commit or push the draft file — drafts are filesystem-only
- Never silently overwrite an existing draft — always display and confirm first
- Always write atomically via temp-file rename — never write directly to the final path
- Validate `name`, `area`, and `priority` before any file creation — stop on invalid input
