## 1. Template resolver and hash utilities

- [ ] 1.1 Create `src/scaffold/template-resolver.ts` exporting `resolveTemplatesDir(): string`. Implementation climbs from `fileURLToPath(import.meta.url)` to find the nearest ancestor containing `package.json` with `name: "agentic-mcp-teaming"` and a sibling `templates/opsx/` directory. Honours `OPSX_TEMPLATES_DIR` override when set to an absolute path containing the expected layout (`opsx/commands/`, `opsx/skills/`, `opsx/topology/`). Throws a descriptive error on failure.
- [ ] 1.2 Create `src/scaffold/hashes.ts` exporting `hashFile(path): Promise<string>` (SHA-256 hex of file contents) and `hashContent(text): string`. Pure functions; unit-testable without filesystem.
- [ ] 1.3 Unit tests in `tests/scaffold-template-resolver.test.ts`: dev-mode resolution succeeds from the repo root; override env var wins; missing templates throw with a helpful message (match regex).
- [ ] 1.4 Unit tests in `tests/scaffold-hashes.test.ts`: known content produces known hash; identical content produces identical hashes; `hashFile` reads bytes not strings (handles UTF-8 + trailing newline correctly).

## 2. Topology config reader and writer

- [ ] 2.1 Create `src/scaffold/topology-config.ts` exporting a Zod schema `TopologyConfig` matching spec D7: `{ version: z.literal(1), topology: z.literal("single"), feature_worktree_path: z.string().min(1), merge_strategy: z.literal("squash") }.strict()`.
- [ ] 2.2 Export `readTopologyConfig(repoRoot): TopologyConfig` — reads `.opsx-toolkit/topology.yaml`, parses YAML via the `yaml` npm package (add dep), runs Zod validation. Throws descriptive errors naming the file when missing or malformed.
- [ ] 2.3 Export `writeTopologyConfig(repoRoot, config)` — serialises via `yaml.stringify`, writes atomically (tmp + rename).
- [ ] 2.4 Unit tests in `tests/scaffold-topology-config.test.ts`: valid config round-trips; unknown key rejected at parse; wrong literal rejected; missing file throws with a message naming `topology.yaml`.

## 3. Template copy templates for opsx commands and skills

- [ ] 3.1 Create `templates/` at the repo root. Add `templates/opsx/topology/single.yaml` with the minimum valid content and a placeholder `{{feature_worktree_path}}` for scaffold-time substitution:
  ```yaml
  version: 1
  topology: single
  feature_worktree_path: "{{feature_worktree_path}}"
  merge_strategy: squash
  ```
- [ ] 3.2 Copy the four existing opsx commands from `.claude/commands/opsx/` (apply.md, archive.md, explore.md, propose.md) into `templates/opsx/commands/`. Drop the "(Experimental)" descriptor from each frontmatter `description` field.
- [ ] 3.3 Copy the five existing skills from `.claude/skills/` (openspec-apply-change/, openspec-archive-change/, openspec-explore/, openspec-propose/, run-review-gate/) into `templates/opsx/skills/`. No edits — these are already topology-agnostic.
- [ ] 3.4 Write `templates/opsx/commands/worktree.md` adapted from `/Users/nick.bourke/Documents/sysdig/projects/sysdig-pov-docs/.claude/commands/opsx/worktree.md`. Collapse the 3-area model to single-slot per spec "Single-slot paused-branch is one-depth only": replace the sibling-worktree area scan with a single check against the resolved `feature_worktree_path`; drop the area-aware cross-area paused-branch verification; reject stacked paused-branch. Begin the command with a "Resolve configuration" step that reads `.opsx-toolkit/topology.yaml`.
- [ ] 3.5 Write `templates/opsx/commands/sync.md` adapted from sysdig-pov-docs. Collapse the 3-row Active Worktrees table to a 1-row single-slot table; drop the per-area worktree-identification logic; use the resolved `feature_worktree_path` for the single active check.
- [ ] 3.6 Write `templates/opsx/commands/merge.md` adapted from sysdig-pov-docs. Drop the area-rotation logic entirely; after squash-merge and main pull, rebase the single feature worktree (if present); consult archived `paused-branch` field and restore the paused branch per the single-depth semantics.
- [ ] 3.7 Write `templates/opsx/commands/ship.md` adapted from sysdig-pov-docs. Locate the archived `.openspec.yaml` without the area field; rest of the behaviour (stage: ship, push, open PR via `gh pr create`) unchanged.
- [ ] 3.8 Write `templates/opsx/commands/draft.md` adapted from sysdig-pov-docs. Scan only the single feature worktree at `feature_worktree_path` for drafts.
- [ ] 3.9 Write `templates/opsx/commands/status.md` adapted from sysdig-pov-docs. Single-row table; drop the area column; drop the per-slot path expansion (use the single `feature_worktree_path`).
- [ ] 3.10 Write `templates/opsx/commands/review.md` adapted from sysdig-pov-docs. Replace every `cd ../sysdig-pov-docs-<area>` error message with `cd <feature_worktree_path>`. Remove the area-branch precondition checks.
- [ ] 3.11 Update `package.json` `files` array to include `templates`. Verify with `npm pack --dry-run` that the tarball contains `templates/` contents.

## 4. Scaffold subcommand

- [ ] 4.1 Create `src/scaffold/scaffold.ts` exporting `runScaffold(opts: { topology: "single"; force: boolean; dryRun: boolean; cwd: string }): Promise<{ written: string[]; conflicted: string[]; skipped: string[] }>`. Implementation:
  - Resolve repo root via `git rev-parse --show-toplevel` (execFile, not shell); exit non-zero if not in a git repo.
  - Compute default `feature_worktree_path` as `../<basename(repoRoot)>-feature`.
  - Enumerate files to write: walk `templates/opsx/commands/`, `templates/opsx/skills/`, one `topology.yaml`, plus `.opsx-toolkit/hashes.json` and `.opsx-toolkit/VERSION` (generated, not copied).
  - For each target path, check existence. If any exist and `--force` is false, collect into `conflicted` and fail-report; write nothing.
  - In `--dry-run`, enumerate intended writes, do nothing, print the plan.
  - In write mode: create parent directories with mode 0o755 as needed; write each file (commands + skills by copy, topology.yaml with the `{{feature_worktree_path}}` substitution); compute each written file's hash; build `hashes.json` with `{ [relative-path]: hash }`; write `VERSION` with the package.json `version`.
- [ ] 4.2 Register the `scaffold` subcommand on the Commander program in `src/index.ts`. Options: `--opsx` (required; no other flavours exist yet), `--topology <value>` (default `single`, currently must equal `single`), `--force` (boolean), `--dry-run` (boolean).
- [ ] 4.3 Unit tests in `tests/scaffold-action.test.ts` mocking filesystem via a tmp dir: clean scaffold writes all expected files + hashes + version; dirty scaffold fails without --force; --force overwrites; --dry-run writes nothing; topology.yaml contains the correct resolved `feature_worktree_path`; hashes.json round-trips (re-reading each file and re-hashing matches the stored hash).

## 5. opsx-upgrade subcommand

- [ ] 5.1 Create `src/scaffold/opsx-upgrade.ts` exporting `runOpsxUpgrade(opts: { force: boolean; dryRun: boolean; cwd: string })`. Implementation:
  - Locate repo root + `.opsx-toolkit/hashes.json`; error if missing.
  - Enumerate template files (same set as scaffold).
  - For each file: compute `baselineHash` from hashes.json (or null if never scaffolded — this file was added in a new template); compute `currentHash` from disk (or null if missing); compute `newHash` from template.
  - Classify: `unchanged` (baseline == current AND current != new); `user-modified` (baseline != current); `missing` (current == null); `new-addition` (baseline == null); `identical` (current == new — no action needed).
  - Drive per-file action:
    - `unchanged`: overwrite with template; update hashes entry.
    - `user-modified`: in `--force` mode overwrite; in `--dry-run` report; interactively show diff and prompt (use Node's readline; prompts = accept / keep / abort).
    - `missing`: skip unless `--force`, in which case re-create.
    - `new-addition` (file present in new templates but not in old hashes.json): create.
    - `identical`: no-op.
  - After processing, rewrite `hashes.json` with the effective end-state hashes.
  - Rewrite `VERSION` with the current package.json version.
- [ ] 5.2 Register the `opsx-upgrade` subcommand in `src/index.ts`. Options: `--force`, `--dry-run`.
- [ ] 5.3 Unit tests in `tests/opsx-upgrade-action.test.ts` mocking filesystem via tmp dir: unchanged file auto-updates and hash rolls forward; user-modified file in --force mode overwrites; user-modified file in --dry-run reports without writing; missing file skipped; missing file with --force re-created; new-addition file created; hashes.json rewritten correctly; missing hashes.json fails with a descriptive error.

## 6. Integration tests (subprocess-based)

- [ ] 6.1 Create `tests/scaffold-integration.test.ts` following the subprocess pattern from `tests/serve-mode.test.ts`.
- [ ] 6.2 Scenario: clean scaffold. In a tmp git repo, run `npx tsx src/index.ts scaffold --opsx`. Assert exit code 0; assert `.claude/commands/opsx/worktree.md` exists; assert `.opsx-toolkit/topology.yaml` parses and has `feature_worktree_path` ending in `-feature`; assert `.opsx-toolkit/hashes.json` exists and contains SHA-256 entries for every command + skill.
- [ ] 6.3 Scenario: dirty scaffold without --force exits non-zero. In the same tmp repo, after a first scaffold, run again without flags; assert exit code non-zero; assert stderr mentions conflicting files.
- [ ] 6.4 Scenario: --dry-run does not write. After a first scaffold, delete a scaffolded file; run `scaffold --opsx --dry-run`; assert the file is NOT recreated.
- [ ] 6.5 Scenario: opsx-upgrade no-op when hashes match. After a scaffold, run `opsx-upgrade` immediately; assert exit 0, no prompts.
- [ ] 6.6 Scenario: opsx-upgrade --force overwrites user modifications. After scaffold, edit a scaffolded file; run `opsx-upgrade --force`; assert the file matches the template again.
- [ ] 6.7 Scenario: opsx-upgrade without hashes.json fails clearly. In a fresh tmp repo, run `opsx-upgrade`; assert exit non-zero and stderr names `hashes.json`.
- [ ] 6.8 Scenario: scaffold refuses outside a git repo. In a tmp dir that is not a git repo, run `scaffold --opsx`; assert exit non-zero and stderr mentions "git".

## 7. Dogfood: apply scaffold to this repo

- [ ] 7.1 Run `npx tsx src/index.ts scaffold --opsx --force` from this repo's root to install the scaffolded workflow in-place. Expected changes: 4 existing opsx commands overwritten (content should be identical or near-identical per D10), 7 new opsx commands added, 5 skills already present and re-written (content identical), `.opsx-toolkit/` directory created. Commit the result in the same commit as the feature code.
- [ ] 7.2 Manual smoke test: run `/opsx:status` in this repo (should show the single slot as `(free)` because `../agentic-mcp-teaming-feature` does not exist yet).
- [ ] 7.3 Commit `.opsx-toolkit/topology.yaml`, `.opsx-toolkit/hashes.json`, `.opsx-toolkit/VERSION` alongside the scaffolded command/skill files. Confirm `git status` shows clean-vs-staged sanity.

## 8. Documentation

- [ ] 8.1 README: add a new "Adopting opsx in a new project" section under "Integration guide". Describe the three-step flow: install coordinator → run `scaffold --opsx` → commit the scaffolded files + `.opsx-toolkit/`. Include the single-slot topology example and a note that area topology is a planned extension.
- [ ] 8.2 README: document `coordinator opsx-upgrade` separately with a short section on the unchanged/modified/missing classification and when to use `--force`.
- [ ] 8.3 CLAUDE.md: add a short "opsx toolkit" section noting that this repo is self-scaffolded (uses the templates it ships) and that template changes should be tested by re-running `scaffold --opsx --force` locally before committing.
- [ ] 8.4 Create `docs/opsx-toolkit.md` with the topology config schema reference, the hashes file format, the upgrade detection classification table, and a note on the `OPSX_TEMPLATES_DIR` override for development.

## 9. Manual verification

- [ ] 9.1 After task 7 lands in this repo, run `coordinator scaffold --opsx --dry-run` from a different tmp directory (a fresh git repo with no prior scaffold). Confirm the dry-run output lists the expected 17 files.
- [ ] 9.2 Run `coordinator scaffold --opsx` in that tmp repo. Confirm the scaffold succeeds; inspect `.opsx-toolkit/topology.yaml` has a `feature_worktree_path` matching the tmp repo's basename.
- [ ] 9.3 Edit `.claude/commands/opsx/status.md` in the tmp repo; then run `coordinator opsx-upgrade`. Confirm the interactive prompt fires with a diff of the local change vs the template.
- [ ] 9.4 Run `npm run build && npm test`; all tests pass including the new scaffold + upgrade suites.
