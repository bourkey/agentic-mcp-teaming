# Agentic MCP Teaming

A multi-agent coordination framework where any number of named specialists — architects, security reviewers, implementers, testers — collaborate via a shared MCP coordination bus. Agents review each other's work in parallel, reach unanimous consensus on plans and designs, and co-implement code through an isolated Git worktree pipeline.

## How it works

All agents connect to a single MCP coordinator server. Every interaction — tool calls, agent invocations, workflow control, and consensus decisions — flows through that one server. The coordinator drives a phase-based workflow (proposal → design → specs → tasks → implementation), invokes all configured reviewers in parallel for each round, and requires unanimous approval before advancing. Any agent can block or request changes; blocked artifacts immediately escalate to a human checkpoint.

See [docs/architecture.md](docs/architecture.md) for the full design.

## Prerequisites

- Node.js 20+
- Git
- CLI tools for each configured agent installed and authenticated (e.g. `claude`, `codex`) — at least one agent with `canRevise: true` and one with `canImplement: true` must be present in `mcp-config.json`

## Installation

```bash
npm install
```

## Configuration

### 1. Environment variables

Copy `.env.example` to `.env`:

```bash
cp .env.example .env
```

| Variable | Required | Description |
|---|---|---|
| `COORDINATOR_PORT` | No | Port for the coordinator MCP server (default: `3100`) |
| `SESSIONS_DIR` | No | Directory for session state and audit logs (default: `./sessions`) |
| `COORDINATOR_AUTH_TOKEN` | Required when binding beyond loopback | Bearer/query token for MCP HTTP transport |

No API keys are required. Agent invocations call each agent's configured CLI directly using your existing authentication.

### 2. MCP server config

Edit `mcp-config.json` to configure the coordinator:

```json
{
  "port": 3100,
  "host": "127.0.0.1",
  "rootDir": ".",
  "toolAllowlist": ["read_file", "write_file", "grep", "glob",
                    "invoke_agent", "invoke_reviewer",
                    "submit_for_consensus", "advance_phase",
                    "get_session_state", "resolve_checkpoint"],
  "authTokenEnvVar": "COORDINATOR_AUTH_TOKEN",
  "agents": {
    "architect": {
      "cli": "claude",
      "specialty": "System design and architecture",
      "canReview": true,
      "canRevise": true
    },
    "implementer": {
      "cli": "codex",
      "specialty": "Code implementation",
      "canReview": true,
      "canImplement": true
    }
  },
  "consensus": { "maxRounds": 3 },
  "spawning": {
    "maxDepth": 2,
    "maxConcurrentSubInvocations": 5,
    "maxSessionInvocations": 50
  },
  "reviewers": {
    "claude-security": {
      "stage": ["spec", "code"],
      "role": "security-reviewer",
      "specialty": "Security vulnerabilities, injection risks, authentication, data exposure"
    },
    "claude-quality": {
      "stage": ["code"],
      "role": "quality-reviewer",
      "specialty": "Code quality, error handling, maintainability"
    },
    "codex-peer": {
      "stage": ["spec", "code"],
      "role": "peer-reviewer",
      "specialty": "General correctness and completeness",
      "optional": true,
      "cli": "codex"
    }
  }
}
```

| Field | Description |
|---|---|
| `port` | Port the coordinator MCP server listens on |
| `host` | Host the coordinator binds to; defaults to `127.0.0.1` |
| `rootDir` | Filesystem root for shared tools — paths and symlink targets outside this directory are rejected |
| `toolAllowlist` | Which MCP tools are exposed; remove a tool name to disable it. `bash` is opt-in and should stay disabled unless you explicitly need it |
| `authTokenEnvVar` | Environment variable containing the MCP transport auth token; required when `host` is broader than loopback |
| `agents` | Named agent registry; each entry requires `cli` (the command to invoke) and optional capability flags (`canReview`, `canRevise`, `canImplement`, `allowSubInvocation`) and `specialty` description |
| `consensus.maxRounds` | Maximum revision rounds before escalating to a human checkpoint (default: 3) |
| `spawning.maxDepth` | Maximum agent call-tree depth; invocations deeper than this are rejected (default: 2) |
| `spawning.maxConcurrentSubInvocations` | Maximum concurrent delegated agent invocations from a single agent turn (default: 5) |
| `spawning.maxSessionInvocations` | Total invocation budget for the session; exhaustion escalates to a human checkpoint (default: 50) |
| `reviewers` | Named reviewer registry for the review gate. Each entry requires `stage` (array of `"spec"` and/or `"code"`), `role`, and `specialty`. Reviewers with a `cli` field are invoked as external CLIs via `invoke_reviewer`; reviewers without `cli` are dispatched as Claude sub-agents. `optional: true` suppresses errors if the CLI is unavailable. |

**Reviewer entry fields**

| Field | Required | Description |
|---|---|---|
| `stage` | Yes | Array of stages this reviewer participates in: `"spec"`, `"code"`, or both |
| `role` | Yes | Role label used in review prompts and the review summary |
| `specialty` | Yes | Short description of what this reviewer focuses on |
| `optional` | No | If `true`, unavailability of the CLI is reported as a warning rather than an error (default: `false`) |
| `cli` | No | CLI command to use for external reviewer invocation. When absent, reviewer is dispatched as a Claude sub-agent |

### 3. Connect Claude to the coordinator (optional)

To let Claude call coordinator tools directly during its own turns, add the coordinator to Claude's MCP config (`~/.claude/mcp.json` or equivalent):

```json
{
  "mcpServers": {
    "coordinator": {
      "url": "http://localhost:3100/sse"
    }
  }
}
```

If you bind the coordinator beyond `127.0.0.1`, include the configured auth token in the client connection settings supported by your MCP client.

## Quickstart (dry-run, no API keys needed)

```bash
npm start -- start --dry-run
```

`--dry-run` replaces both real agent APIs with mock responders that always return `approve`. All coordinator logic — consensus loop, session state, audit log, human checkpoints — runs normally. Use this to verify the setup before spending API budget.

## Running a real workflow

```bash
# Start from the proposal phase
npm start -- start --workflow proposal

# Resume an interrupted session
npm start -- start --session <session-id>

# Check session state
npm start -- status --session <session-id>
```

### CLI flags

| Flag | Default | Description |
|---|---|---|
| `--workflow <phase>` | `proposal` | Starting phase: `proposal`, `design`, `spec`, `task`, `implementation` |
| `--session <id>` | — | Resume an existing session by its ID |
| `--dry-run` | false | Use mock agents; no real API calls |
| `--config <path>` | `mcp-config.json` | Path to the MCP server config file |
| `--sessions-dir <path>` | `./sessions` | Directory for session storage |
| `--openspec-dir <path>` | `./openspec/changes/claude-codex-teaming` | Directory containing proposal.md, design.md, specs/, tasks.md |

## Workflow phases

1. **Proposal** — All reviewers review `proposal.md` in parallel and must reach unanimous consensus before continuing.
2. **Design** — All reviewers review `design.md`.
3. **Specs** — Each spec file under `specs/` is reviewed individually.
4. **Tasks** — All reviewers review `tasks.md` and task assignments are produced.
5. **Implementation** — Each task is implemented by its assigned agent in an isolated Git worktree, reviewed by the reviewing agent, and merged into the session branch.

At the boundary of each phase, the coordinator pauses for a human checkpoint. Respond `proceed` to advance or `abort` to halt.

## Review gates

Two automated review gates run at key points in the `/opsx:propose` and `/opsx:apply` workflows:

| Gate | Trigger | Stage |
|---|---|---|
| Spec gate | After all OpenSpec artifacts are written by `/opsx:propose` | `spec` |
| Code gate | After all tasks are marked complete by `/opsx:apply` | `code` |

Each gate dispatches all configured reviewers in parallel — Claude sub-agents (no `cli` field) and external CLI reviewers (`cli` field) simultaneously. A synthesis agent deduplicates findings, detects conflicts, and assigns dispositions:

- **`auto-apply`** — Critical uncontested, or major with ≥ 2 reviewer agreement: applied immediately
- **`escalate`** — Critical contested, or major/minor with conflicting proposed fixes: surfaced to the user for a decision
- **`drop`** — Minor with no consensus: silently dropped

After the gate, `review-gate.lock` is written to the change directory and `review-summary.md` is appended with a findings table. `/opsx:apply` warns (but does not block) if `review-gate.lock` is absent when implementation begins.

## Session storage

Each session creates a directory at `sessions/<session-id>/`:

```
sessions/<session-id>/
  state.json      # Current phase, artifact outcomes, worktree metadata
  audit.log       # Newline-delimited JSON — every tool call and agent turn
  snapshots/      # Review snapshots capturing artifact + tool outputs per round
```

See [docs/session-format.md](docs/session-format.md) for the full schema.

## Troubleshooting

**`Could not resolve authentication method`** — one of the configured agent CLIs is not authenticated in your environment. Use `--dry-run` to test without live agent invocations.

**`working tree has uncommitted changes`** — Commit or stash your changes before running the implementation phase. The coordinator creates Git worktrees from the current HEAD.

**`config file not found`** — Run from the repository root, or pass `--config <path>` pointing to your `mcp-config.json`.

**Agent timeout** — The default timeout is 120 seconds per agent invocation. For slow models, consider increasing `timeoutMs` in the coordinator source or breaking large tasks into smaller ones.

**Stuck at a human checkpoint** — Type `proceed` to advance or `abort` to halt the workflow. If using `--dry-run`, checkpoints auto-proceed.

**`Reviewer not found`** — The `reviewerId` passed to `invoke_reviewer` does not exist in `mcp-config.json → reviewers`, or the reviewer has no `cli` field. Only reviewers with a `cli` field can be invoked via `invoke_reviewer`.

**`Reviewer not configured for stage`** — The reviewer's `stage` array does not include the requested stage. Check the `stage` field in `mcp-config.json → reviewers`.

**Reviewer timeout warning** — A CLI reviewer did not respond within the timeout period. Its findings are recorded as empty. If it is non-optional, check that the CLI is installed and authenticated. Set `"optional": true` to suppress this as a warning.
