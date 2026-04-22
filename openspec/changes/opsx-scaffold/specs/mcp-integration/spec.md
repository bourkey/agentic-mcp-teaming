## ADDED Requirements

### Requirement: Coordinator binary exposes scaffold and opsx-upgrade subcommands

The `coordinator` CLI SHALL expose `scaffold` and `opsx-upgrade` subcommands alongside the existing server subcommands (`serve`, `start`, `status`) and any client subcommands added by separate changes. Both SHALL be listed in `coordinator --help` with short descriptions.

- `coordinator scaffold --opsx [--topology <value>] [--force] [--dry-run]` — writes the opsx toolkit into the current repo.
- `coordinator opsx-upgrade [--force] [--dry-run]` — updates a previously-scaffolded toolkit using hash-based change detection.

Neither subcommand SHALL touch `mcp-config.json`, `.env`, or any coordinator-runtime configuration. They operate exclusively on the opsx workflow toolkit (`.claude/commands/opsx/`, `.claude/skills/*`, `.opsx-toolkit/`).

#### Scenario: Subcommands listed in --help
- **WHEN** `coordinator --help` is invoked
- **THEN** the output SHALL include `scaffold` and `opsx-upgrade` with one-line descriptions referencing the opsx toolkit

#### Scenario: Subcommands do NOT touch coordinator-runtime files
- **WHEN** either subcommand is invoked in a repo with an existing `mcp-config.json`
- **THEN** the subcommand SHALL NOT modify `mcp-config.json`, SHALL NOT modify `.env` or `.env.example`, SHALL NOT modify `sessions/`, and SHALL NOT modify any file outside `.claude/` or `.opsx-toolkit/`

### Requirement: Template location resolution is robust across install shapes

The subcommands SHALL resolve the templates directory by locating the running binary's package root via `import.meta.url` and expecting a `templates/opsx/` sibling of `package.json`. The resolution SHALL succeed across:

- Dev run (`tsx src/index.ts scaffold ...` with templates at the repo root).
- `npm link` install (linked `dist/index.js` with templates at the original repo root).
- Global install via `npm install -g` (templates under `node_modules/agentic-mcp-teaming/templates/` in the global prefix).

An `OPSX_TEMPLATES_DIR` environment variable SHALL override the resolution if set to an absolute path pointing at a directory containing `opsx/commands/`, `opsx/skills/`, and `opsx/topology/`. If the resolver cannot find templates via either mechanism, the subcommand SHALL exit non-zero with a clear error explaining the expected layout and the `OPSX_TEMPLATES_DIR` override.

#### Scenario: Dev-mode resolution
- **WHEN** the subcommand runs via `tsx src/index.ts` with `package.json` at the repo root and `templates/opsx/` adjacent to it
- **THEN** resolution SHALL succeed and the subcommand SHALL use the repo-root templates

#### Scenario: Linked-install resolution
- **WHEN** the binary is invoked via `coordinator` from a globally-linked install
- **THEN** resolution SHALL locate the templates inside the linked package directory, NOT inside the consuming project

#### Scenario: Override via env var
- **WHEN** `OPSX_TEMPLATES_DIR=/opt/my-templates` is set AND that directory contains the expected subdirectories
- **THEN** the subcommand SHALL read templates from `/opt/my-templates` regardless of package layout

#### Scenario: Missing templates produces a helpful error
- **WHEN** templates cannot be located via either mechanism
- **THEN** the subcommand SHALL exit non-zero with an error naming the expected layout and the `OPSX_TEMPLATES_DIR` escape hatch
