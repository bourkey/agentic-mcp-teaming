## Why

The opsx workflow (propose → apply → worktree → ship → merge → sync → archive, plus explore/draft/review/status) is good enough that we want to use it in new projects, not just sysdig-pov-docs. Today the commands live as markdown files in sysdig-pov-docs's `.claude/commands/opsx/`, tuned for its 3-area frontend/backend/misc topology, with path conventions like `../sysdig-pov-docs-<area>` baked into the text. Copying them verbatim into another repo breaks on first run. Adapting them is a manual rewrite every time.

This change turns the `coordinator` binary into the distribution channel for the opsx toolkit. A new `coordinator scaffold --opsx` subcommand drops a full opsx workflow into any repo, reading from `templates/opsx/` shipped alongside the binary. The templates use a single-slot topology — one feature worktree at `../<repo-basename>-feature` — which fits solo developers and small teams with sequential flow. sysdig-pov-docs's richer area topology stays handcrafted for now and can move to a `--topology area` variant in a follow-up change when we want to generalise it.

The coordinator binary is already earning its keep as a server (`serve`/`start`/`status`), is about to gain client subcommands (`register`/`send`/etc. from `coordinator-client-cli`), and now picks up a third role as the opsx toolkit distributor. One binary, three jobs, installed once on your PATH and reused across every project.

This change also applies the scaffold to THIS repo so `/opsx:worktree`, `/opsx:ship`, `/opsx:merge`, `/opsx:sync`, `/opsx:draft`, `/opsx:status`, and `/opsx:review` become available here. From the next change onward we can stop committing directly to `main` and use the worktree workflow locally.

## What Changes

### New subcommands on the `coordinator` binary

- `coordinator scaffold --opsx [--topology single] [--force] [--dry-run]` — creates `.claude/commands/opsx/`, `.claude/skills/openspec-*/`, `.claude/skills/run-review-gate/`, and `.opsx-toolkit/` in the current repo. Refuses to overwrite any existing file unless `--force`. `--dry-run` prints what would change without writing. `--topology` defaults to `single` and is the only accepted value in this change (area reserved for a future change).
- `coordinator opsx-upgrade [--force] [--dry-run]` — compares each scaffolded file's current hash against the hash stored at scaffold time. Silently updates files with unchanged hashes (user didn't touch them), shows a diff and prompts on files whose hashes differ (user modified), skips files absent from the new template (presumed intentionally deleted). `--force` accepts all updates without prompting; `--dry-run` only reports.

### New `templates/` directory shipped with the binary

- `templates/opsx/commands/` — one markdown per opsx command (11 files):
  - `apply.md`, `archive.md`, `explore.md`, `propose.md` — copied from this repo's existing command set with generic rewording (drop the "(Experimental)" tags since they are now stable enough to ship).
  - `draft.md`, `merge.md`, `review.md`, `ship.md`, `status.md`, `sync.md`, `worktree.md` — adapted from sysdig-pov-docs by collapsing the area topology. Every `sysdig-pov-docs-<area>` path becomes `<repo-basename>-feature`; every area-rotation branch becomes a single-slot branch; the paused-branch mechanism survives as single-depth (one pause at a time) rather than cross-area stacked.
- `templates/opsx/skills/` — copies of `openspec-apply-change`, `openspec-archive-change`, `openspec-explore`, `openspec-propose`, `run-review-gate`. All five are already project-agnostic; no rewording needed.
- `templates/opsx/topology/single.yaml` — the default `.opsx-toolkit/topology.yaml` content, with placeholders for values the scaffold resolves at write time.

### New `.opsx-toolkit/` directory in each consumer repo

- `.opsx-toolkit/topology.yaml` — committed. Shape:
  ```yaml
  version: 1
  topology: single
  feature_worktree_path: "../<repo-basename>-feature"
  merge_strategy: squash
  ```
- `.opsx-toolkit/hashes.json` — committed. SHA-256 of each scaffolded file at scaffold or last successful upgrade. Enables `opsx-upgrade` to detect user modifications.
- `.opsx-toolkit/VERSION` — committed. The coordinator binary version that produced the current scaffold.

### Commands read topology at runtime

Every adapted command begins with a "Resolve configuration" step that reads `.opsx-toolkit/topology.yaml` from the repo root and uses the resolved `feature_worktree_path` (and later, `areas`) for path construction. No command hardcodes path strings.

If `.opsx-toolkit/topology.yaml` is missing or malformed when a command runs, the command SHALL exit with a clear error pointing at `coordinator scaffold --opsx`.

### Apply the scaffold to THIS repo as part of this change

Task 7.1 applies the scaffold to `agentic-mcp-teaming` — writes the 11 commands, updates the existing 4, writes `.opsx-toolkit/` files. From then on, changes in this repo use the same workflow as sysdig-pov-docs (just single-slot instead of area).

## Capabilities

### New Capabilities
- `opsx-toolkit`: the scaffold/upgrade subcommands, the templates directory layout, the `.opsx-toolkit/` config and hashes conventions, and the single-slot topology's command contracts (what each opsx command does at runtime once scaffolded into a consumer repo).

### Modified Capabilities
- `mcp-integration`: adds the `scaffold` and `opsx-upgrade` subcommands to the CLI surface and documents the coordinator binary's third role (scaffold distributor) alongside server and client.

## Impact

- **New code**:
  - `src/scaffold/` directory: `scaffold.ts` (action), `opsx-upgrade.ts` (action), `template-resolver.ts` (locates `templates/` at runtime — robust across `npm link`, global install, dev run), `hashes.ts` (SHA-256 file hashing for upgrade detection), `topology-config.ts` (reads/writes `.opsx-toolkit/topology.yaml`).
- **New non-code**: the `templates/` directory at the repo root with 11 command files + 5 skill directories + 1 topology template.
- **Modified code**: `src/index.ts` (two new subcommands); `package.json` (add `templates` to the `files` array so npm publishes them).
- **No server-side changes**. This change touches client tooling only. `coordinator serve/start/status` and the peer-bus tools are untouched.
- **Bidirectional portability**: projects using the scaffolded toolkit benefit from future improvements via `opsx-upgrade`; projects that already have handcrafted commands (sysdig-pov-docs) are not affected until they explicitly scaffold.
- **Dogfood in this repo**: after this change lands, `agentic-mcp-teaming` uses the scaffolded workflow itself, including `/opsx:worktree ../agentic-mcp-teaming-feature`.
- **Explicitly deferred** (each its own follow-up):
  - Area topology (`--topology area`) — the richer variant sysdig-pov-docs uses. Port once we have a second consumer actually needing it.
  - Scaffolding `mcp-config.json` — stays outside the opsx toolkit; the scaffold is workflow-only. A separate `coordinator init` or similar could own that later.
  - Custom reviewer personas (the `.claude/agents/` files sysdig-pov-docs ships). They're review-gate implementation details, not part of the opsx CLI.
  - A "remove opsx from this repo" uninstall subcommand. Out of scope; operators `rm -rf .claude/commands/opsx .claude/skills/openspec-*` if they really want to.
