---
name: "OPSX: Merge"
description: Merge an open PR, sync all worktrees, and rotate the freed slot to the next change
category: Workflow
tags: [workflow, git, pr, merge]
---

Merge a PR, pull main, rebase all active worktrees, and rotate the freed worktree to the next queued change.

Run this from the **main checkout** after a worktree session runs `/opsx:ship`.

**Input**: PR number (e.g. `/opsx:merge 69`). If omitted, list open PRs and ask.

**Steps**

1. **Resolve the PR**

   If no number provided:
   ```bash
   gh pr list --state open
   ```
   Use AskUserQuestion to select.

2. **Check local main is clean (commits, staged, unstaged, untracked)**

   ```bash
   git log origin/main..HEAD --oneline
   git status --short
   ```

   - If `git log` lists any commits: main has local-only commits that weren't pushed via PR. **Stop.** Surface the commits and tell the user to push them via a PR or `git push` before merging.
   - If `git status` shows any staged, modified, or untracked files: **stop.** The merge skill makes direct commits to main in step 8c.iii (stale-cleanup) and step 8g (paused-branch resume cleanup) — an unrelated dirty file would be silently swept into either commit. Tell the user to commit, stash, or discard the local changes before retrying. Do not proceed.
   - If both are empty: main is clean, continue.

3. **Check CI**

   ```bash
   gh pr checks <number>
   ```

   - If checks are pending: show status and wait — do NOT merge until all pass.
   - If checks failed: surface the failures and stop. Do not merge a failing PR.
   - If no checks reported: verify the PR only touches frontend files (no `src/`, `tests/`, `alembic/`). If so, safe to proceed. Otherwise warn.

4. **Merge**

   ```bash
   gh pr merge <number> --squash --delete-branch
   ```

5. **Pull main**

   ```bash
   git pull
   ```

6. **Identify the freed worktree**

   ```bash
   git worktree list
   ```

   The freed worktree is the one whose branch no longer exists (was deleted by `--delete-branch`). Compare the branch name from the PR against current worktrees to find which path was freed.

   Derive the area from the branch name: `feat/<change-name>` → look up `.openspec.yaml` in the archive for `area`. If multiple archive entries match (re-archived change), use the one with the most recent date prefix.

7. **Rebase all other active worktrees**

   For each worktree that is NOT main and NOT the freed slot:
   ```bash
   git -C <worktree-path> fetch origin
   git -C <worktree-path> rebase origin/main
   ```

   If a worktree has unstaged changes it cannot be rebased automatically — note it in the summary and tell the user to rebase from within that pane when at a stopping point. Do not stop the entire merge sequence for this.

   If a rebase fails with conflicts (not unstaged changes): surface the conflict and stop. Do not proceed to slot rotation until the conflict is resolved manually. Once resolved, resume from step 8 and continue through step 11 — step 11 (sync todos.md) captures the merge record. If you cannot immediately resume the full sequence, run `/opsx:sync` manually from the main checkout once the conflict is cleared to record the completed merge.

8. **Check for a paused branch to resume (primary signal — before consulting the queue)**

   The `paused-branch` field in the merged change's archived `.openspec.yaml` is the authoritative signal that a branch was intentionally paused. This check MUST run before the queue scan — a queue pick silently overrides intended resume signals otherwise.

   **Capture main HEAD before any direct commits in this merge run** so step 10 can detect whether step 8 OR step 9.5 (compaction) added direct commits (needed to know whether to re-rebase active worktrees). The variable name reflects its scope — it covers step 8's stale-cleanup/paused-branch-clear commits AND step 9.5's priority-compaction commit:

   ```bash
   PRE_DIRECT_COMMITS_MAIN=$(git rev-parse HEAD)
   ```

   a. **Validate the merged change name and locate the archived `.openspec.yaml`:**

      First, validate `<merged-change-name>` against `^[a-z0-9][a-z0-9-]{0,62}$` — the same regex enforced by `/opsx:propose` and `/opsx:worktree`. If validation fails (the branch name was malformed somehow), abort the paused-branch check, log a warning, and fall through to the queue scan (step 9). Validation prevents regex-metacharacter injection into the next command.

      Use a non-regex enumeration so the change name does not need escaping:
      ```bash
      ls openspec/changes/archive/ | awk -v n="<merged-change-name>" '$0 ~ ("^[0-9]{4}-[0-9]{2}-[0-9]{2}-" n "$") {print}'
      ```
      Note: even though `awk` is technically a regex match, `<merged-change-name>` is now constrained to `[a-z0-9-]` by validation above, none of which are regex metacharacters — so this is safe by construction.

      If no matching directory exists: warn the user that the archive path could not be found, skip the paused-branch check, and fall through to the queue scan (step 9). Use the most recent date prefix if multiple matches.

   b. **Read the `paused-branch` field** from `openspec/changes/archive/<resolved-dir>/.openspec.yaml`.

      - If the field is absent: fall through to the queue scan (step 9).
      - If the field is present but parses to an unexpected YAML type (not a string scalar or sequence of strings — e.g., a mapping, integer, boolean): warn the user, clear the field from the archived `.openspec.yaml` via the **stale-cleanup commit pattern** (described below in step 8c.iii), and fall through to the queue.

   c. **Normalize to a sequence:** if the value is a scalar, treat it as a one-element list. Validate each element against `^feat/[a-z0-9][a-z0-9-]{0,62}$`.

      i. For each invalid element: warn the user and remove it from the list.
      ii. For each valid element: check existence using a **local-or-remote** test. A branch may exist only on `origin` (local-only pruning, fresh clone, etc.) — testing only `git branch --list` would falsely declare it stale and the cleanup commit below would erase a legitimate paused branch.

          Use `git ls-remote` as the authoritative remote probe — it queries the remote directly without depending on a local remote-tracking ref existing. Do NOT swallow fetch/ls-remote errors with `|| true`: a transient network or auth failure must NOT trigger the destructive stale-cleanup. On any non-zero exit, leave the entry in place and warn the user that existence could not be confirmed:
          ```bash
          # Probe local first
          if git rev-parse --verify <value> >/dev/null 2>&1; then
            : # local branch exists — keep
          else
            # Probe remote authoritatively
            if ! REMOTE_OUT=$(git ls-remote --heads origin <value> 2>&1); then
              echo "warning: cannot confirm existence of <value> on origin (network/auth error: $REMOTE_OUT) — keeping entry, NOT marking stale"
              # keep the entry; do not trigger stale-cleanup based on a failed probe
            elif [ -n "$REMOTE_OUT" ]; then
              : # remote branch exists — keep
            else
              # truly stale: neither local nor remote — remove from list with warning
            fi
          fi
          ```
      iii. **Stale-cleanup commit pattern:** if any elements were removed (invalid OR truly stale), the cleaned `.openspec.yaml` MUST be persisted to main. Rewrite the file via read-modify-write (atomically), then check whether the file actually changed before committing — if not, skip the commit (avoids `nothing to commit` failure). If the push fails, **stop the merge sequence** and surface the error — do not proceed to step 9/10/11 with unpushed commits on main:
          ```bash
          git add openspec/changes/archive/<resolved-dir>/.openspec.yaml
          if ! git diff --cached --quiet -- openspec/changes/archive/<resolved-dir>/.openspec.yaml; then
            git commit -m "chore(opsx): clean stale paused-branch entries from <merged-change>"
            if ! git push; then
              echo "ERROR: push failed for stale-cleanup commit. Main is locally ahead. Resolve the push failure before re-running /opsx:merge."
              exit 1
            fi
          fi
          ```
          Without this commit, the next `/opsx:merge` re-reads the same stale data and produces a false resume attempt.

      After filtering, if no valid, existing candidates remain: fall through to the queue (the stale-cleanup commit above already persisted the empty/cleaned state).

   d. **Cross-area check:** for each remaining candidate `feat/<other-change>`, derive `<other-change>` by stripping the `feat/` prefix from the candidate branch value (the branch value was already validated against `^feat/[a-z0-9][a-z0-9-]{0,62}$` in step 8c, so the suffix is safe to use as a path component):
      ```bash
      OTHER_CHANGE=${candidate#feat/}
      ```

      The candidate change may be either active (still in `openspec/changes/`) or already archived. Try both, in order:

      ```bash
      # safe: $OTHER_CHANGE was derived from a candidate that was validated against ^feat/[a-z0-9][a-z0-9-]{0,62}$ in step 8c — no path traversal or regex metacharacters possible
      # 1. Active path
      if [ -f "openspec/changes/$OTHER_CHANGE/.openspec.yaml" ]; then
        AREA=$(grep -E '^area:' "openspec/changes/$OTHER_CHANGE/.openspec.yaml" | head -1 | awk '{print $2}')
      else
        # 2. Archived path with date prefix — same enumeration pattern as step 8a
        ARCHIVE_DIR=$(ls openspec/changes/archive/ | awk -v n="$OTHER_CHANGE" '$0 ~ ("^[0-9]{4}-[0-9]{2}-[0-9]{2}-" n "$") {print}' | tail -1)
        if [ -n "$ARCHIVE_DIR" ]; then
          AREA=$(grep -E '^area:' "openspec/changes/archive/$ARCHIVE_DIR/.openspec.yaml" | head -1 | awk '{print $2}')
        fi
      fi
      # validate AREA is one of the known enum values; if not, drop the candidate
      case "$AREA" in
        frontend|backend|misc) ;;
        *) echo "warning: invalid or missing area for $OTHER_CHANGE — dropping candidate"; continue ;;
      esac
      ```

      If `AREA` cannot be determined (neither path found), warn the user and remove the candidate (cannot verify cross-area without it).

      If a candidate's `AREA` differs from the freed slot's area, warn the user ("Paused branch `feat/<x>` is in area `<a>` but the freed slot is for area `<b>` — cannot resume via this rotation") and remove it from the candidate list.

      After cross-area filtering, if no candidates remain: fall through to the queue (step 9).

   e. **Select a branch to resume:**

      - If one candidate remains: select it.
      - If multiple candidates remain: use AskUserQuestion to let the user pick which to resume.

   f. **Rotate the freed worktree to the selected paused branch (verify add before destroying remove):**

      `git worktree remove` followed by a failing `git worktree add` would destroy the freed slot with no replacement. Verify the add is viable before removing — pre-fetch the branch and ensure the target path is writable:

      ```bash
      git fetch --quiet origin <selected-feat-branch> 2>/dev/null || true
      # Confirm the branch ref resolves locally or remotely
      git rev-parse --verify <selected-feat-branch> 2>/dev/null || \
        git rev-parse --verify origin/<selected-feat-branch> 2>/dev/null
      ```

      If neither resolves, abort the resume — surface the error, do NOT remove the freed worktree, and fall through to the queue.

      Otherwise, perform remove + add. If `git worktree add` fails after the remove succeeded, the slot is now orphaned. Recovery: re-create the worktree on `main` as a placeholder, surface the error to the user, and tell them to manually re-run `/opsx:worktree <selected-change>` once the underlying issue is resolved.

      ```bash
      git worktree remove <freed-path>
      if ! git worktree add <freed-path> <selected-feat-branch>; then
        # Recovery — restore the slot to a known-good placeholder
        git worktree add <freed-path> main
        echo "ERROR: paused-branch resume failed for <selected-feat-branch>. Slot restored to main as placeholder. Re-run /opsx:worktree <selected-change> after resolving."
        exit 1
      fi
      ```

      Note: `git worktree add <path> <existing-branch>` checks out the existing branch rather than creating a new one.

   g. **Clear the resumed entry from `paused-branch`:**

      - If the stored field was originally a scalar: remove the `paused-branch` field entirely.
      - If the stored field was a sequence: remove only the resumed entry from the sequence; rewrite the remaining entries back to the archived `.openspec.yaml`. Remaining entries MUST be preserved so subsequent merges can resume them.

      Write atomically (read → modify → write full file). Commit and push the updated archive file to main. **If the push fails, stop the merge sequence** — main is now locally ahead and the rest of the merge cannot proceed safely:
      ```bash
      git add openspec/changes/archive/<resolved-dir>/.openspec.yaml
      git commit -m "chore(opsx): resume <resumed-change>, clear paused-branch entry"
      if ! git push; then
        echo "ERROR: push failed for resume-clear commit. Main is locally ahead. Resolve the push failure before re-running /opsx:merge — the freed slot has already been rotated to <resumed-change>."
        exit 1
      fi
      ```

   h. **Skip the queue scan** (step 9) — the slot has been rotated. Continue to step 10.

9. **Find the next change for the freed area** (only if no paused branch was resumed)

   Read `.openspec.yaml` for all active changes in `openspec/changes/`:
   ```bash
   for d in openspec/changes/*/; do
     grep -l "area: <freed-area>" "$d/.openspec.yaml" 2>/dev/null
   done
   ```

   Sort by `priority` field ascending. If multiple changes share the same priority value, use the `created` field in `.openspec.yaml` as a secondary sort (earliest date first — oldest change). Pick the first result not already in a worktree. Cross-check candidates against the Queue section of the current `todos.md` to confirm each candidate has an active GitHub issue before selecting it; skip any that do not appear in Queue. If `todos.md` does not exist or has no Queue section, skip the cross-check and rely on the priority sort alone.

   If no change is queued for that area: suggest pulling from another area or leave the slot free. Ask the user.

9a. **Rotate the freed worktree** (only if selecting from the queue — step 8 already rotated if a paused branch was resumed)

   ```bash
   git worktree remove <freed-path>
   git worktree add -b feat/<next-change-name> <freed-path>
   ```

9.5. **Compact priorities within the merged change's area**

   Runs on EVERY merge (queue-pick OR paused-branch resume). Renumbers remaining queue items to `1..N` so `.openspec.yaml` priority values accurately reflect position in queue after items leave it. Full contract: `openspec/specs/opsx-merge-skill/spec.md`.

   a. **Idempotent re-entry scan** — detect whether compaction already ran for this merge:

      ```bash
      git fetch origin main --quiet
      COMPACT_SUBJECT="chore(opsx): compact <merged-area>-area priorities after merge of <merged-change-name>"
      REMOTE_MATCH=$(git log origin/main --format='%H %s' | grep -F "$COMPACT_SUBJECT" | awk '{print $1}' | head -n1)
      LOCAL_MATCH=$(git log origin/main..HEAD --format='%H %s' 2>/dev/null | grep -F "$COMPACT_SUBJECT" | awk '{print $1}' | head -n1)
      ```

      Three cases:
      - `REMOTE_MATCH` non-empty → compaction already on `origin/main`. If `.opsx-compaction-journal.yaml` exists, delete it (its intent is satisfied by the remote commit). Skip to step 10.
      - `LOCAL_MATCH` non-empty AND `REMOTE_MATCH` empty → pending-push recovery is incomplete. Abort with: "Compaction commit is on local HEAD but not `origin/main`. Run `git push origin main` to complete the pinned recovery, then re-run `/opsx:merge <PR>`." Do NOT silently skip (that would re-rebase worktrees onto a base missing the compaction commit).
      - Both empty → if `.opsx-compaction-journal.yaml` exists, run the journal-restore procedure (step 9.5.g below) BEFORE starting fresh enumeration. Otherwise proceed.

      Verify any matched commit's diff touches only `openspec/changes/*/.openspec.yaml`:

      ```bash
      if [ -n "$REMOTE_MATCH" ]; then
        TOUCHED=$(git show --name-only --format= "$REMOTE_MATCH" | grep -v '^$' | grep -v '^openspec/changes/.*/\.openspec\.yaml$' || true)
        if [ -n "$TOUCHED" ]; then
          echo "ERROR: matched compaction commit $REMOTE_MATCH has divergent diff: $TOUCHED"
          exit 1
        fi
      fi
      ```

   b. **Enumerate active changes** in the merged area and capture the renumber set:

      ```bash
      # Runaway-enumeration guard: cap total subdirs
      TOTAL_DIRS=$(find openspec/changes/ -mindepth 1 -maxdepth 1 -type d -not -path 'openspec/changes/archive' | wc -l)
      if [ "$TOTAL_DIRS" -gt 100 ]; then
        echo "ERROR: more than 100 subdirectories under openspec/changes/ (runaway-enumeration guard)"
        exit 1
      fi

      # Parse every .openspec.yaml via Python YAML safe-load (NOT line-based grep — must handle CRLF, BOM, quoted scalars).
      # Capture the output JSON as $RENUMBER (list of {path, old, new, dir}). The heredoc is single-quoted so Python sees
      # the literal source; the merged-area value is passed via environment variable MERGED_AREA to avoid shell injection.
      RENUMBER=$(MERGED_AREA="<merged-area>" python3 <<'PY'
      import os, yaml, sys, json, re, subprocess
      from pathlib import Path

      CHANGES = Path("openspec/changes")
      AREA = os.environ["MERGED_AREA"]
      KEBAB = re.compile(r"^[a-z0-9][a-z0-9-]*$")

      def die(msg):
          # Never echo arbitrary field values — only path + field name.
          print(f"ERROR: {msg}", file=sys.stderr); sys.exit(1)

      # lstat parent dir first
      parent_st = os.lstat(CHANGES)
      if (parent_st.st_mode & 0o170000) != 0o040000:  # S_IFDIR
          die(f"{CHANGES} is not a regular directory")

      all_active = []
      missing_manifest = []
      paused_refs = set()

      for entry in sorted(CHANGES.iterdir()):
          if entry.name == "archive": continue
          if not entry.is_dir(): continue
          if not KEBAB.match(entry.name):
              die(f"openspec/changes/<dir> basename does not match kebab-case regex at {entry}")
          manifest = entry / ".openspec.yaml"
          if not manifest.exists():
              missing_manifest.append(str(entry)); continue
          st = os.lstat(manifest)
          if (st.st_mode & 0o170000) != 0o100000:  # S_IFREG
              die(f"{manifest} is not a regular file (symlink or special)")
          parent_st2 = os.lstat(entry)
          if (parent_st2.st_mode & 0o170000) != 0o040000:
              die(f"{entry} parent is not a regular directory")
          with open(manifest, "rb") as f:
              data = yaml.safe_load(f)
          if not isinstance(data, dict):
              die(f"{manifest} is not a YAML mapping")
          area = data.get("area")
          if area not in ("frontend", "backend", "misc"):
              die(f"{manifest} field `area` is invalid or missing")
          pri = data.get("priority")
          if not isinstance(pri, int) or pri < 1:
              die(f"{manifest} field `priority` must be a positive integer")
          created = data.get("created")
          cs = str(created) if created is not None else ""
          if not (re.match(r"^\d{4}-\d{2}-\d{2}$", cs) or re.match(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}", cs)):
              die(f"{manifest} field `created` is not ISO-8601 date or datetime")
          # paused-branch may be scalar (single feat/<name>) OR sequence (list of feat/<name>, per worktree.md chain-of-pauses)
          pb = data.get("paused-branch")
          pb_refs = []
          if isinstance(pb, str): pb_refs = [pb]
          elif isinstance(pb, list): pb_refs = [str(x) for x in pb]
          elif pb is not None:
              die(f"{manifest} field `paused-branch` must be a scalar or sequence of feat/<name> values")
          for ref in pb_refs:
              if not re.match(r"^feat/[a-z0-9][a-z0-9-]*$", ref):
                  die(f"{manifest} field `paused-branch` contains a malformed entry (must match feat/<kebab-name>)")
              paused_refs.add(ref.removeprefix("feat/"))
          all_active.append({"dir": entry.name, "area": area, "priority": pri, "created": cs, "path": str(manifest)})

      if missing_manifest:
          # Each entry is a validated kebab-case directory path; emit count + one per line (no f-string interpolation of list).
          sys.stderr.write(f"ERROR: {len(missing_manifest)} directories missing .openspec.yaml:\n")
          for d in missing_manifest: sys.stderr.write(f"  {d}\n")
          sys.exit(1)

      area_set = [c for c in all_active if c["area"] == AREA]
      if len(area_set) > 100:
          die(f"more than 100 active changes in area {AREA}")

      wt_out = subprocess.run(["git", "worktree", "list", "--porcelain"], capture_output=True, text=True, check=True).stdout
      slot_branches = set()
      current_wt = None
      for line in wt_out.splitlines():
          if line.startswith("worktree "):
              current_wt = line.removeprefix("worktree ").strip()
          elif line.startswith("branch ") and current_wt:
              if any(os.path.realpath(current_wt).endswith(f"/generic-consumer-{a}") for a in ("frontend", "backend", "misc")):
                  slot_branches.add(line.removeprefix("branch refs/heads/").strip())

      queued = [c for c in area_set if f"feat/{c['dir']}" not in slot_branches and c["dir"] not in paused_refs]

      # Sort by (priority ASC, created ASC, name ASC) — three stable keys
      def sort_key(c):
          created = c["created"]
          if "T" not in created:
              created = created + "T00:00:00Z"
          return (c["priority"], created, c["dir"])
      queued.sort(key=sort_key)

      # Compute target priorities 1..N; emit only entries where priority changes
      renumber = []
      for i, c in enumerate(queued, start=1):
          if c["priority"] != i:
              renumber.append({"path": c["path"], "old": c["priority"], "new": i, "dir": c["dir"]})

      print(json.dumps(renumber))
      PY
      )
      ```

      `$RENUMBER` is a JSON array. If it equals `[]`, skip to step 9.5.f (no-op; do not produce an empty commit).

   c. **Write rollback journal** at repo root before any mutation. sha256 is computed over the **entire pre-mutation file bytes** (not over a derived "file minus priority" form):

      ```bash
      RENUMBER_JSON="$RENUMBER" python3 <<'PY'
      import os, hashlib, json, yaml
      renumber = json.loads(os.environ["RENUMBER_JSON"])
      entries = []
      for r in renumber:
          with open(r["path"], "rb") as f:
              data = f.read()
          entries.append({
              "path": r["path"],
              "priority": r["old"],
              "target_priority": r["new"],
              "sha256": hashlib.sha256(data).hexdigest(),
          })
      with open(".opsx-compaction-journal.yaml", "w") as f:
          yaml.safe_dump({"entries": entries}, f)
      PY
      ```

   d. **Iterate rewrites in DESCENDING target priority order** to avoid transient duplicate-priority windows. Rewrite ONLY the `priority:` line via a targeted regex replace — this preserves comments, key order, quote style, and whitespace exactly (no YAML round-trip library required):

      ```bash
      RENUMBER_PATHS=()
      RENUMBER_JSON="$RENUMBER" python3 <<'PY'
      import os, re, json, sys
      renumber = json.loads(os.environ["RENUMBER_JSON"])
      # Descending target priority — highest target first so no two files share a priority mid-batch
      for r in sorted(renumber, key=lambda r: -r["new"]):
          path = r["path"]
          with open(path, "r") as f:
              text = f.read()
          # Replace ONLY the first top-level `priority: <digits>` line (YAML block-scalar).
          # Match: optional leading whitespace + `priority:` + whitespace + digits + end-of-line.
          pattern = re.compile(r"(?m)^(priority:\s*)(\d+)(\s*(?:#.*)?)$")
          new_text, n = pattern.subn(lambda m: f"{m.group(1)}{r['new']}{m.group(3)}", text, count=1)
          if n != 1:
              print(f"ERROR: could not find a single top-level `priority:` line in {path}", file=sys.stderr)
              sys.exit(1)
          tmp = path + ".tmp"
          with open(tmp, "w") as f:
              f.write(new_text)
          os.replace(tmp, path)
          print(path)
      PY
      # Collect staged-paths list from the Python printout
      while IFS= read -r line; do RENUMBER_PATHS+=("$line"); done < <(RENUMBER_JSON="$RENUMBER" python3 -c "import json,os; [print(r['path']) for r in json.loads(os.environ['RENUMBER_JSON'])]")
      ```

   e. **Commit and push**:

      ```bash
      # Stage only the renumbered files (paths already captured in RENUMBER_PATHS array during step 9.5.d)
      for p in "${RENUMBER_PATHS[@]}"; do
          git add "$p"
      done
      git -c commit.gpgsign=false commit --no-edit -m "chore(opsx): compact <merged-area>-area priorities after merge of <merged-change-name>"
      COMPACTION_SHA=$(git rev-parse HEAD)

      # Pre-push freshness check: did origin/main advance during compaction?
      git fetch origin main --quiet
      ORIGIN_MAIN=$(git rev-parse origin/main)
      LOCAL_BASE=$(git merge-base HEAD origin/main)
      if [ "$ORIGIN_MAIN" != "$LOCAL_BASE" ]; then
          # origin/main advanced during compaction. Perform FULL ROLLBACK via the journal
          # (restore pre-mutation file contents BEFORE deleting the journal), then soft-reset
          # the commit. Re-run is safe because PR merge + slot rotation are idempotent.
          python3 <<'PY'
      import os, hashlib, yaml, sys
      from pathlib import Path
      if not Path(".opsx-compaction-journal.yaml").exists():
          print("ERROR: journal missing during rollback; manual reconciliation required", file=sys.stderr); sys.exit(1)
      with open(".opsx-compaction-journal.yaml") as f:
          j = yaml.safe_load(f)
      for e in j["entries"]:
          with open(e["path"], "rb") as f:
              current = f.read()
          if hashlib.sha256(current).hexdigest() == e["sha256"]:
              continue  # never mutated; leave as-is
          # File was mutated — expect on-disk priority == target_priority; restore to recorded priority
          text = current.decode()
          import re
          pattern = re.compile(r"(?m)^(priority:\s*)(\d+)(\s*(?:#.*)?)$")
          m = pattern.search(text)
          if not m or int(m.group(2)) != e["target_priority"]:
              print(f"ERROR: journal/working-tree divergence at {e['path']}; reconcile manually", file=sys.stderr); sys.exit(1)
          new_text, _ = pattern.subn(lambda mm: f"{mm.group(1)}{e['priority']}{mm.group(3)}", text, count=1)
          tmp = e["path"] + ".tmp"
          with open(tmp, "w") as f:
              f.write(new_text)
          os.replace(tmp, e["path"])
      PY
          ROLLBACK_RC=$?
          if [ "$ROLLBACK_RC" -ne 0 ]; then
              echo "ERROR: rollback failed; journal retained for manual reconciliation"
              exit 1
          fi
          # The python block above has already restored each file's priority on disk.
          # Now unstage + un-commit so git's view matches the restored working tree:
          # - `git reset HEAD -- openspec/changes/` unstages the shifted files so the index is clean.
          # - `git reset --soft HEAD~1` un-does the compaction commit, keeping the (now-restored) working tree.
          # Do NOT run `git checkout -- openspec/changes/` — that would overwrite the restored files
          # with the staged post-compaction snapshot, undoing the rollback.
          git reset HEAD -- openspec/changes/
          git reset --soft HEAD~1
          rm -f .opsx-compaction-journal.yaml
          echo "ERROR: origin/main advanced during compaction; rolled back; re-run /opsx:merge <PR>"
          exit 1
      fi

      git push origin main
      ```

      **On push failure:** classify the error message.

      - **Non-fast-forward** (`Updates were rejected because the remote contains work`): race between freshness check and push. Perform full rollback (journal-restore, `git reset --soft HEAD~1`, delete journal), surface "origin/main advanced during push; full rollback complete; re-run `/opsx:merge <PR>`." Re-running IS safe.
      - **Auth / network / branch-protection**: the commit is on local HEAD. Journal stays. Do NOT invoke step 10 or step 11. Emit the paste-ready recovery block:

        ```
        Compaction commit landed locally but push failed. SHA: <SHA>. Recovery:
          git show <SHA>              # confirm the pending commit
          git push origin main
          /opsx:sync                  # refresh todos.md
          # Re-rebase active worktrees manually (step 10 was skipped by the halt):
          for area in frontend backend misc; do
            git -C ../generic-consumer-$area fetch --quiet origin main
            git -C ../generic-consumer-$area rebase origin/main
          done
        Do NOT re-run /opsx:merge <PR> — the PR is already merged and the slot has rotated.
        ```

        Halt with non-zero exit.

   f. **On successful push, delete the journal:**

      ```bash
      rm -f .opsx-compaction-journal.yaml
      ```

   g. **Journal-restore procedure** (called by 9.5.a's "no-match + journal exists" branch). Uses the same sed-style regex replace as step 9.5.d so no YAML round-trip library is required:

      ```bash
      python3 <<'PY'
      import os, sys, re, hashlib, yaml
      from pathlib import Path
      if not Path(".opsx-compaction-journal.yaml").exists():
          print("ERROR: journal-restore called but .opsx-compaction-journal.yaml not found", file=sys.stderr); sys.exit(1)
      with open(".opsx-compaction-journal.yaml") as f:
          j = yaml.safe_load(f)
      pattern = re.compile(r"(?m)^(priority:\s*)(\d+)(\s*(?:#.*)?)$")
      for e in j["entries"]:
          with open(e["path"], "rb") as f:
              current = f.read()
          if hashlib.sha256(current).hexdigest() == e["sha256"]:
              continue  # file was never mutated; leave as-is
          text = current.decode()
          m = pattern.search(text)
          if not m or int(m.group(2)) != e["target_priority"]:
              print(f"ERROR: journal/working-tree divergence at {e['path']}; reconcile manually", file=sys.stderr); sys.exit(1)
          new_text, _ = pattern.subn(lambda mm: f"{mm.group(1)}{e['priority']}{mm.group(3)}", text, count=1)
          tmp = e["path"] + ".tmp"
          with open(tmp, "w") as f:
              f.write(new_text)
          os.replace(tmp, e["path"])
      os.remove(".opsx-compaction-journal.yaml")
      PY
      ```

      After journal-restore completes, return to the caller's next step.

10. **Re-rebase active worktrees if any direct commits landed in steps 8 or 9.5**

    Step 7 rebased all active worktrees onto `origin/main` BEFORE step 8 ran. If step 8 produced any direct commits (8c.iii stale-cleanup, 8g resume-clear) OR step 9.5 produced a priority-compaction commit, those commits landed AFTER the rebase — every active worktree is now one or more commits behind main.

    Compare the captured `PRE_DIRECT_COMMITS_MAIN` (saved at the top of step 8; the variable's scope covers both step 8 direct commits AND step 9.5's compaction commit) against current HEAD. If different, re-rebase each active worktree (NOT the freed slot — that was already rotated to a fresh branch in step 8f or 9a):

    ```bash
    POST_DIRECT_COMMITS_MAIN=$(git rev-parse HEAD)
    if [ "$PRE_DIRECT_COMMITS_MAIN" != "$POST_DIRECT_COMMITS_MAIN" ]; then
      # main moved due to step 8 or step 9.5 commits — re-rebase active worktrees
      for wt in <each worktree path that is NOT main and NOT the freed slot>; do
        git -C "$wt" fetch origin
        git -C "$wt" rebase origin/main
      done
    fi
    ```

    Conflict handling is the same as step 7 — note conflicts in the summary, do not stop the entire sequence.

11. **Sync todos.md**

    Now that the merge is complete, the slot has been rotated (or left free), and worktrees have been re-rebased if needed, rebuild `todos.md`:

    ```
    /opsx:sync
    ```

    This captures the merge record (closed issue → `merged`) and the new slot state (new branch → `in-progress`, or free slot). Runs even when the freed slot is left empty — the free slot must be recorded in `todos.md`.

12. **Emit `rebased` and `slot-freed` peer-bus events (optional; silently skipped when the bus is off)**

    Must run AFTER step 11 so `baseSha` reflects the post-sync HEAD of `origin/main`. See `openspec/specs/portal-opsx-peer-bus/spec.md` (post-archive) for the normative contract.

    Gate: ALL of the following must be true, otherwise SKIP silently:
    - `$COORDINATOR_SESSION_NAME` is set (this pane runs from main so the launcher set it),
    - `$PEER_BUS_DISABLED` is NOT equal to `1`,
    - the `coordinator` MCP tool is available.

    **Capture once** — do this BEFORE any emit:
    ```bash
    BUS_BASE_SHA=$(git rev-parse origin/main)
    ```
    Every emit this invocation makes uses `$BUS_BASE_SHA` — do NOT re-run `git rev-parse` per recipient.

    **For each active area pane** (frontend / backend / misc whose sibling worktree currently exists — this includes the freed slot if it was rotated to a fresh branch, since the new branch is at the same `baseSha`) **whose rebase or rotation landed successfully**:

    ```
    send_message({
      sessionToken: <cached session token>,
      to: "claude:<area>",
      kind: "workflow-event",
      body: {
        event: "rebased",
        area: "<area>",
        baseSha: "<BUS_BASE_SHA>"          # 40-char lowercase hex
      }
    })
    ```

    **Then** — one `slot-freed` to `main` (the merged branch's area is the freed area):

    ```
    send_message({
      sessionToken: <cached session token>,
      to: "claude:main",
      kind: "workflow-event",
      body: {
        event: "slot-freed",
        area: "<freed-area>"                # area of the just-merged branch
      }
    })
    ```

    Body-field hygiene: only the pinned fields above. `baseSha` is the captured value; `area` is drawn from the allowlist `{frontend, backend, misc}`. Do NOT include commit messages, PR titles, or any free-text.

    **Per-area rebase failure handling.** If step 7 failed to rebase one area (conflict), SKIP the `rebased` emit for that area — do NOT emit to a pane that is not actually rebased. Log `peer-bus: skipped rebased for area=<x> (rebase failed)`. `slot-freed` still emits because the squash-merge itself succeeded.

    **Error handling (per emit).** `invalid_session_token` → startup-skill recovery. Any other named error (`recipient_not_registered`, `mailbox_full`, ...) or transport-level failure → log ONCE per session as `peer-bus: <error> for <event>/<area>` and CONTINUE the loop — do NOT abort other emits. The merge summary output is unchanged by any emit outcome.

13. **Display summary**

   ```
   ## Merged

   **PR:** #<number> — <title>
   **Branch deleted:** feat/<merged-change>

   **Worktrees synced:**
   - frontend (feat/portal-tenant-detail-ux) — rebased ✓
   - backend (feat/portal-auth-hardening) — rebased ✓

   **Slot rotated:**
   - misc: feat/portal-update-prompt → feat/portal-data-privacy

   (When the slot is resumed from a paused branch rather than pulled from the queue, the new-branch label includes `(resumed — was paused)`, e.g. `misc: feat/portal-update-prompt → feat/portal-data-privacy (resumed — was paused)`.)

   ---
   Next step — branch on rotation outcome:

   **Case A — slot rotated to a queued change** (fresh branch from queue):
   ```
   Switch to your <area> tmux pane and run:
   cd <freed-path> && claude
   /opsx:apply <next-change-name>
   ```

   **Case B — slot resumed from a paused branch** (in-progress work):
   ```
   Switch to your <area> tmux pane and run:
   cd <freed-path> && claude
   /opsx:apply <resumed-change-name>
   ```
   The branch already has prior in-progress work — `/opsx:apply` continues from where it left off. If a `chore(wip): pause <resumed-change>` commit was the last commit, consider `git reset HEAD~1` first to restore the WIP changes to the working tree.

   **Case C — slot left free** (no queued change, no paused branch):
   ```
   No next step — slot ../generic-consumer-<area> is empty. Run /opsx:worktree <name> when you're ready to start the next change in this area.
   ```
   ```

**Guardrails**
- Stop if local main has unpushed commits — surface them before merging (step 2)
- Never merge if CI is failing — surface failures and stop
- Never merge from a worktree — this skill is main-pane only
- Unstaged changes in a worktree: note in summary, do not stop the sequence
- Rebase conflicts (not unstaged changes): stop and surface before continuing
- Always check `paused-branch` BEFORE scanning the queue — paused branches are intentional resume signals
- Validate `paused-branch` value against `^feat/[a-z0-9][a-z0-9-]{0,62}$` before passing to git — clear invalid values
- Only remove the resumed entry from a `paused-branch` sequence — never clear the whole field if other entries remain
- Cross-area paused branches cannot resume via area-scoped rotation — fall through to the queue with a warning
- If no next change exists for the freed area, ask the user rather than leaving the worktree in a broken state
- Never commit directly to main — use a worktree branch and PR instead (exception: the archive mutation in step 8g is in-scope for this skill)
