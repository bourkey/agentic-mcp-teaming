## ADDED Requirements

### Requirement: `coordinator scaffold --opsx` installs the opsx toolkit into the current repo

The `coordinator scaffold` subcommand SHALL accept `--opsx`, an optional `--topology <value>` (default `single`; only `single` is accepted in this change), `--force`, and `--dry-run`. When invoked in a git repository, it SHALL create the following paths relative to the repository root (as resolved by `git rev-parse --show-toplevel`):

- `.claude/commands/opsx/*.md` — 11 command files from `templates/opsx/commands/`.
- `.claude/skills/openspec-apply-change/SKILL.md`, `.claude/skills/openspec-archive-change/SKILL.md`, `.claude/skills/openspec-explore/SKILL.md`, `.claude/skills/openspec-propose/SKILL.md`, `.claude/skills/run-review-gate/SKILL.md` — 5 skill files from `templates/opsx/skills/`.
- `.opsx-toolkit/topology.yaml` — populated from `templates/opsx/topology/single.yaml` with `feature_worktree_path` resolved to `../<repo-basename>-feature` where `<repo-basename>` is `basename(git rev-parse --show-toplevel)`.
- `.opsx-toolkit/hashes.json` — SHA-256 hex digest of every file listed above (relative-path keys, digest values).
- `.opsx-toolkit/VERSION` — the coordinator binary version that performed the scaffold.

On a clean target (none of the above paths exist), the scaffold SHALL write every file and exit with status 0. On a dirty target (any path exists), the scaffold SHALL exit with a non-zero status and print a report listing the conflicting paths, unless `--force` is supplied. With `--dry-run`, the subcommand SHALL print what would be created without writing anything.

#### Scenario: Clean scaffold
- **WHEN** `coordinator scaffold --opsx` is run in a git repo where `.claude/commands/opsx/` and `.opsx-toolkit/` do not exist
- **THEN** the subcommand SHALL create all 17 documented files (11 commands + 5 skills + 1 topology config) plus the `hashes.json` and `VERSION` markers, and exit 0

#### Scenario: Dirty target refuses without --force
- **WHEN** `coordinator scaffold --opsx` is run in a repo where `.claude/commands/opsx/worktree.md` already exists
- **THEN** the subcommand SHALL exit non-zero and print a report naming the conflicting file; NO writes SHALL occur

#### Scenario: --force overwrites conflicts
- **WHEN** `coordinator scaffold --opsx --force` is run in the same dirty target
- **THEN** the subcommand SHALL proceed, overwriting conflicting files, and write fresh hashes

#### Scenario: --dry-run previews without writing
- **WHEN** `coordinator scaffold --opsx --dry-run` is run
- **THEN** the subcommand SHALL print the list of files it would create or overwrite and exit 0, and NO file SHALL be written or modified

#### Scenario: Refuses an unsupported topology value
- **WHEN** `coordinator scaffold --opsx --topology area` is run
- **THEN** the subcommand SHALL exit non-zero with an error naming `topology` and listing the accepted values (`single`)

#### Scenario: Refuses outside a git repo
- **WHEN** `coordinator scaffold --opsx` is run in a directory that is not inside a git working tree
- **THEN** the subcommand SHALL exit non-zero with an error directing the user to run it from inside a git repository

### Requirement: `coordinator opsx-upgrade` propagates template updates using hash-based change detection

The `coordinator opsx-upgrade` subcommand SHALL accept optional `--force` and `--dry-run` flags. When invoked, it SHALL:

1. Read `.opsx-toolkit/hashes.json` to determine the baseline hash of each scaffolded file.
2. For each file listed in the current binary's templates:
   - Compute the SHA-256 of the current on-disk content.
   - Compare with the stored baseline hash AND with the template's new hash.
   - Classify each file:
     - **Unchanged by user** (current hash == baseline hash): silently overwrite with the new template; update the baseline.
     - **Modified by user** (current hash != baseline hash): show a diff between the current file and the new template; prompt the operator to accept / keep / interactive-merge (accept → overwrite + update baseline; keep → leave file untouched, update baseline to the current hash so future upgrades don't re-prompt until another change).
     - **Missing** (file on disk does not exist): skip silently unless `--force`, in which case re-create.
3. Write `.opsx-toolkit/hashes.json` with updated hashes after successful completion.
4. Write `.opsx-toolkit/VERSION` with the current binary version.

With `--force`, all prompts SHALL be auto-accepted (overwrite). With `--dry-run`, no file SHALL be modified; the subcommand SHALL print the classification + proposed action for each file.

#### Scenario: Unchanged file auto-upgrades
- **WHEN** `coordinator opsx-upgrade` runs and a user has not modified `review.md` since scaffold (current hash == baseline)
- **THEN** the file SHALL be overwritten silently with the new template; the baseline hash in `hashes.json` SHALL be updated to match the new template

#### Scenario: Modified file prompts the operator
- **WHEN** `opsx-upgrade` runs and `worktree.md`'s current hash differs from the baseline
- **THEN** the subcommand SHALL display the diff between the current file and the new template and SHALL prompt the operator with accept / keep / interactive-merge; only the operator's choice SHALL determine the final file content

#### Scenario: --force accepts all updates
- **WHEN** `opsx-upgrade --force` runs with multiple user-modified files
- **THEN** every template file SHALL be overwritten unconditionally; `hashes.json` SHALL reflect the new template hashes for all of them

#### Scenario: Missing file is skipped by default
- **WHEN** `opsx-upgrade` runs and `.claude/commands/opsx/draft.md` does not exist on disk
- **THEN** the subcommand SHALL note the file as absent and skip it; the file SHALL NOT be re-created unless `--force` is supplied

#### Scenario: --dry-run reports without writing
- **WHEN** `opsx-upgrade --dry-run` runs
- **THEN** the subcommand SHALL print the classification for each file (unchanged/modified/missing) and the action it would take, and NO file SHALL be modified, NOR SHALL `hashes.json` or `VERSION` be rewritten

#### Scenario: Missing hashes.json blocks upgrade
- **WHEN** `opsx-upgrade` is run in a repo whose `.opsx-toolkit/hashes.json` does not exist
- **THEN** the subcommand SHALL exit non-zero with an error directing the operator to run `coordinator scaffold --opsx` first

### Requirement: Scaffolded opsx commands read runtime configuration from `.opsx-toolkit/topology.yaml`

Every scaffolded command that constructs filesystem paths (`worktree.md`, `sync.md`, `merge.md`, `status.md`, `draft.md`, `review.md`) SHALL begin with a step that reads `.opsx-toolkit/topology.yaml` from the repository root and uses the resolved `feature_worktree_path` value for path construction. Commands SHALL NOT hardcode any absolute paths, any repository-basename strings, or any "frontend/backend/misc" references.

If `.opsx-toolkit/topology.yaml` is missing, malformed, or fails schema validation when a command runs, the command SHALL exit with a clear error directing the operator to run `coordinator scaffold --opsx`.

#### Scenario: Commands use the configured feature worktree path
- **WHEN** a scaffolded repo has `feature_worktree_path: "../my-project-feature"` in its topology config AND `/opsx:worktree add-auth` is invoked
- **THEN** the command SHALL create the worktree at `../my-project-feature` relative to the repo root, not at any hardcoded path

#### Scenario: Missing topology.yaml fails loudly
- **WHEN** `.opsx-toolkit/topology.yaml` is absent and a scaffolded command is invoked
- **THEN** the command SHALL exit non-zero with an error naming the missing file and suggesting `coordinator scaffold --opsx`

#### Scenario: Invalid topology schema fails loudly
- **WHEN** `topology.yaml` contains `topology: area` (reserved for a future change, not accepted in single-slot commands)
- **THEN** the command SHALL exit non-zero with a schema-validation error naming the offending key and the accepted values

### Requirement: Single-slot topology config shape

The `.opsx-toolkit/topology.yaml` file SHALL have the following shape validated via Zod `.strict()`:

- `version: 1` (literal; the only accepted value in this change).
- `topology: "single"` (literal; `"area"` is reserved for a future change).
- `feature_worktree_path: string` (non-empty).
- `merge_strategy: "squash"` (literal; the only accepted value in this change).

Unknown keys anywhere in the file SHALL cause schema validation to fail.

#### Scenario: Minimal valid config
- **WHEN** `topology.yaml` contains exactly `{ version: 1, topology: "single", feature_worktree_path: "../p-feature", merge_strategy: "squash" }`
- **THEN** validation SHALL succeed and commands SHALL operate against that feature worktree path

#### Scenario: Unknown key rejected
- **WHEN** `topology.yaml` contains `{ …, unknownField: "x" }`
- **THEN** schema validation SHALL fail with an error naming `unknownField`

#### Scenario: Wrong version literal rejected
- **WHEN** `topology.yaml` contains `version: 2`
- **THEN** schema validation SHALL fail with an error noting the expected version

### Requirement: Single-slot paused-branch is one-depth only

The scaffolded `worktree.md` and `merge.md` commands SHALL support at most one paused branch at a time. If the feature slot is occupied by `feat/A` and the operator invokes `/opsx:worktree B` for a new change, the command SHALL pause `feat/A` (record `paused-branch: feat/A` on B's `.openspec.yaml`, commit a WIP on the feature worktree) and switch the slot to `feat/B`. On `/opsx:merge` of B, the command SHALL read `B`'s archived `paused-branch` field and restore the slot to `feat/A`.

If the operator attempts `/opsx:worktree C` while the slot holds `feat/B` and `feat/B`'s `.openspec.yaml` ALREADY has a `paused-branch: feat/A` entry, the scaffold command SHALL refuse the inversion and SHALL suggest either finishing B or un-pausing A first. Single-slot topology SHALL NOT support a stacked paused-branch list.

#### Scenario: First inversion pauses and switches
- **WHEN** the feature slot holds `feat/A` and `/opsx:worktree B` is invoked for a fresh change
- **THEN** the command SHALL commit WIP on `feat/A`, record `paused-branch: feat/A` on B's `.openspec.yaml`, switch the slot to `feat/B`, and succeed

#### Scenario: Second inversion refused
- **WHEN** the feature slot holds `feat/B` and B's `.openspec.yaml` already contains `paused-branch: feat/A`, and `/opsx:worktree C` is invoked
- **THEN** the command SHALL refuse with a clear error explaining that single-slot supports only one paused depth; the slot SHALL remain on `feat/B` and no WIP commit SHALL be created

#### Scenario: Merge resumes the paused branch
- **WHEN** `/opsx:merge <B's PR>` is invoked and B's archived `.openspec.yaml` contains `paused-branch: feat/A`
- **THEN** after the squash-merge and main-pull, the feature worktree SHALL be switched back to `feat/A` and A's WIP commit SHALL remain at the tip of that branch until A resumes implementation
