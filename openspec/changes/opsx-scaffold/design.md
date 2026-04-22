## Context

The opsx workflow started as sysdig-pov-docs's internal tooling, evolved through many iterations (priority inversion, paused-branch mechanism, cross-area merge rotation, review gates), and has stabilised into a shape that's worth porting to other projects. But the commands are tightly coupled to sysdig-pov-docs's specifics: 3-area topology (frontend/backend/misc), `../sysdig-pov-docs-<area>` worktree paths, and a merge queue sorted by area+priority.

This change packages the portable core of opsx as templates shipped inside the `coordinator` binary, with a `scaffold` subcommand that drops them into a new consumer repo in one step. To keep v1 tractable, only the single-slot topology is templated. The richer area topology can be added later without rescoping the scaffold mechanism itself.

Constraints carried forward from the existing codebase:
- TypeScript/Node, ESM modules, `type: module` in `package.json`.
- No new runtime dependencies unless justified — the existing deps (commander, zod) cover command registration and config validation.
- `execFile`-only for any subprocess operations (not especially relevant here; scaffolding is filesystem work).
- No destructive filesystem operations without operator confirmation.

## Goals / Non-Goals

**Goals:**
- `coordinator scaffold --opsx` installs the full opsx workflow into any repo with one command, reading from embedded template files.
- `coordinator opsx-upgrade` propagates improvements to existing consumers, detecting user modifications via file-hash comparison.
- Commands resolve topology-specific paths at runtime from `.opsx-toolkit/topology.yaml` — no values hardcoded in the markdown.
- THIS repo picks up the scaffolded workflow as part of this change.
- Zero impact on `coordinator serve/start/status`/peer-bus code paths.

**Non-Goals:**
- Area topology variant (deferred to a follow-up when demand exists beyond sysdig-pov-docs).
- Scaffolding `mcp-config.json`, `.env.example`, or any coordinator-runtime setup.
- Scaffolding reviewer personas (`.claude/agents/`).
- An uninstall / remove-opsx subcommand.
- Cross-version migrations beyond the trivial file-by-file upgrade (e.g. "converting single → area mid-flight").
- Modification of sysdig-pov-docs's handcrafted commands. It stays as-is until it chooses to migrate.

## Decisions

### D1 — Templates live in a `templates/` directory, shipped with the package

Under the repo root: `templates/opsx/commands/*.md`, `templates/opsx/skills/**`, `templates/opsx/topology/single.yaml`. The npm package `files` array includes `templates/` so they ship with `npm publish`.

**Alternative considered**: embed templates as TypeScript string constants in the binary. Rejected — markdown-as-escaped-strings is painful to edit, and losing syntax highlighting makes review harder.

### D2 — Template location discovered at runtime via `import.meta.url`

The scaffold subcommand needs to find `templates/` regardless of how the binary was installed:
- Dev run: `tsx src/index.ts scaffold ...` with templates next to `src/`.
- `npm link`: `dist/index.js` is symlinked into `node_modules/.bin/`; templates live at `../../templates` relative to the linked file's actual location.
- Global install: `/usr/local/lib/node_modules/agentic-mcp-teaming/templates/`.

The resolution order in `src/scaffold/template-resolver.ts`:
1. Resolve `import.meta.url` → absolute path of the running `.js` file.
2. Climb parents until we find a directory containing both `package.json` and `templates/`.
3. Confirm the `name` in that `package.json` is `agentic-mcp-teaming`.
4. Use `<that-dir>/templates/opsx/` as the template root.

Fail with a clear error if no match is found (should not happen in a correctly-installed binary).

### D3 — Topology config file is committed; hashes file is committed

Both `.opsx-toolkit/topology.yaml` and `.opsx-toolkit/hashes.json` are tracked in git. Reasons:

- **topology.yaml**: every pane/collaborator must see the same topology. Uncommitted would let different contributors end up with different feature-worktree-path conventions.
- **hashes.json**: the upgrade detection relies on knowing the hash AT SCAFFOLD TIME, not the current hash. If `hashes.json` is not committed, an `opsx-upgrade` on a fresh clone would treat every user-edit as pristine. The hashes file pins the baseline.

`.opsx-toolkit/VERSION` is also committed — same reasoning: so all contributors see the same baseline version.

**Alternative considered**: put hashes in `.gitignore`. Rejected for the reason above.

### D4 — `feature_worktree_path` defaults to `../<repo-basename>-feature`

At scaffold time, we derive `<repo-basename>` by running `git rev-parse --show-toplevel` and taking the basename. The scaffold writes the resolved path literal into `topology.yaml`, so even if the repo is later moved or the basename inferred differently, the commands use the exact value from the config.

Operators can edit `topology.yaml` to point somewhere else — but then `opsx-upgrade` sees the hash mismatch on that file and prompts. Acceptable for a config file that humans expect to touch.

**Alternative considered**: templating the path as `{repo-basename}-feature` and resolving dynamically at command runtime. Rejected — adds a substitution layer to every worktree-path usage; cleaner to resolve once at scaffold time and have a literal path in config.

### D5 — Single-slot paused-branch is one-depth only

sysdig-pov-docs's area topology supports a paused-branch stack (one paused branch per area, stackable across areas). Single-slot's simpler contract: at most ONE paused branch. If slot is occupied by A and you want to work on B, you pause A (paused-branch: feat/A written on B's `.openspec.yaml`). If you then want to work on C before B merges, the scaffold refuses — you can't double-stack in single-slot. Either finish B, or unpause A first.

**Alternative considered**: support a stacked paused-branch in single-slot too. Rejected — the use case for stacked pauses is rare, and if you need it that's a signal you should be using area topology.

### D6 — `opsx-upgrade` detection is file-hash-based

On scaffold: write `hashes.json` = `{ <path>: <sha256>, ... }` for every file installed.

On upgrade:
- For each template file, compute the hash of the current on-disk content.
- Compare against the stored hash in `hashes.json`.
- If hashes match → user hasn't touched it → silently overwrite with the new template + update hash.
- If hashes differ → user has modified it → show the diff between current and new template, prompt (accept / keep / interactive-merge).
- Files present in template but absent on disk → probably user deleted intentionally → skip with a warning (do not re-create unless `--force`).
- Files present on disk but absent from template → user-added, leave alone (hashes.json never tracked them).

After a successful upgrade, `hashes.json` is rewritten with the new hashes of whatever files ended up on disk (accepted updates → new template hash; kept user-modifications → existing file's hash).

**Alternative considered**: always-overwrite-unless-`--no-force`. Rejected — too easy to clobber intentional local edits.

### D7 — Topology config schema validation

`topology.yaml` is validated via a Zod schema on every command that reads it. Strict parsing; unknown keys rejected with a clear error. Shape:

```ts
z.object({
  version: z.literal(1),
  topology: z.literal("single"),   // area to be added in v2
  feature_worktree_path: z.string(),
  merge_strategy: z.literal("squash"),
}).strict()
```

If validation fails, the calling command prints the Zod error, names `topology.yaml` as the file, and suggests `coordinator scaffold --opsx` if the file is missing or unrecoverable.

### D8 — Scaffold is idempotent on clean repos, refuses-unless-`--force` on dirty ones

- Clean case (none of the target paths exist): scaffold writes every file, writes `hashes.json`, succeeds.
- Dirty case (any target path exists): scaffold refuses with a report listing the conflicting files. Operator chooses: back up their customisations, run `--force` (overwrites), or use `opsx-upgrade` instead (the honest path if they've already got a scaffold and want updates).

`--dry-run` bypasses the write phase entirely; prints what would happen either way.

### D9 — Apply scaffold to THIS repo as part of this change

Task 7 of the task list runs `coordinator scaffold --opsx --force` against this repo after the new subcommand is implemented and tested. The repo's existing 4 opsx commands (propose/apply/archive/explore) are overwritten by the templates — the templates were copied from them in D1, so this should produce minimal-to-no content change. The 7 new commands (worktree, ship, merge, sync, draft, status, review) show up fresh.

Commit this scaffolding in the same commit as the feature itself so the change record is self-contained.

### D10 — Single-slot commands are adaptations, not rewrites

Every command template originates from a sysdig-pov-docs source:

| Target template | Source | Changes |
|---|---|---|
| `apply.md` | this repo's `apply.md` | drop "(Experimental)" tag |
| `archive.md` | this repo's `archive.md` | drop "(Experimental)" tag |
| `explore.md` | this repo's `explore.md` | drop "(Experimental)" tag |
| `propose.md` | this repo's `propose.md` | drop "(Experimental)" tag |
| `draft.md` | sysdig-pov-docs | replace sibling-path scan with single-slot scan at `$FEATURE_PATH/openspec/drafts/` |
| `merge.md` | sysdig-pov-docs | drop area rotation logic; collapse 3-slot loop to single rebase-of-the-feature-worktree |
| `review.md` | sysdig-pov-docs | replace `cd ../sysdig-pov-docs-<area>` error message with `cd $FEATURE_PATH` |
| `ship.md` | sysdig-pov-docs | drop area resolution from archive lookup; otherwise unchanged |
| `status.md` | sysdig-pov-docs | collapse 3-row table to 1-row; drop area column |
| `sync.md` | sysdig-pov-docs | collapse 3-slot worktree identification to single slot |
| `worktree.md` | sysdig-pov-docs | collapse 3-area selection to single slot; simplify paused-branch to one-depth |

Each commit of a template file in `templates/opsx/commands/` is a transparent adaptation — no reinvention. Reviewers can diff against the sysdig-pov-docs source to see what survived.

## Risks / Trade-offs

- **Risk**: `hashes.json` drifts if an operator edits a scaffolded file without updating the hash.
  **Mitigation**: accepted. The drift is detected on the next `opsx-upgrade` (user-modification prompt fires); worst case is that a user edit is flagged as a conflict and shown in a diff. Not data-loss.

- **Risk**: v1 single-slot is too constraining for a consumer who expected concurrency.
  **Mitigation**: documented scope. Area topology is queued as a follow-up. Anyone bumping into the constraint has a clear path forward.

- **Risk**: template resolver fails on unusual install layouts (a user builds from source into a non-npm location).
  **Mitigation**: the resolver's error message names the expected structure and suggests a fallback — operators can set `OPSX_TEMPLATES_DIR` env var to override (implemented in D2's `template-resolver.ts`).

- **Risk**: the adapted commands have bugs not present in the sysdig-pov-docs originals (introduced during area → single-slot collapse).
  **Mitigation**: dogfooding THIS repo on the scaffolded workflow surfaces bugs quickly. Adopt incrementally; any command proving wrong gets fixed in the templates and re-propagated via `opsx-upgrade`.

- **Risk**: scaffold writes into a repo at the wrong moment (e.g., mid-refactor) and clobbers something the operator didn't expect.
  **Mitigation**: `--dry-run` and the refuses-without-`--force` default. The normal invocation path is safe.

- **Trade-off**: no `uninstall` subcommand. If an operator scaffolds and then regrets it, they rm-rf the directories manually. Accepted — a symmetric uninstall is easy to add later if needed.

## Migration Plan

Additive. No existing consumer is affected unless they explicitly run `scaffold` or `opsx-upgrade`.

1. Merge this change.
2. This repo self-scaffolds as part of task 7.1.
3. Future projects adopt via `coordinator scaffold --opsx` after installing the binary.
4. Existing opsx commands in this repo get overwritten by identical templates (content-identical by D10), so no behavioural change expected. The scaffold just adds the missing 7.

Rollback: remove the scaffold subcommands and templates from the binary. Consumer repos keep their scaffolded copies unchanged (they're real files under git); they just lose the ability to upgrade.

## Open Questions

None outstanding. The scope settled during discussion; all design calls default sensibly.
