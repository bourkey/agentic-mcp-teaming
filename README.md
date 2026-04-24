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
npm run build      # compiles to dist/, marks dist/index.js executable
npm link           # puts the `coordinator` binary on your PATH
```

Verify:

```bash
coordinator --help
```

You should see `serve`, `start`, `status` subcommands.

## Setting up on a new system

Fresh-machine checklist:

```bash
# 1. Prerequisites
node --version    # must be 20+
git --version
tmux --version    # optional but recommended for the "running the coordinator" section below

# 2. Clone + build
git clone https://github.com/bourkey/agentic-mcp-teaming.git
cd agentic-mcp-teaming
npm install
npm run build
npm link

# 3. Configure (see "Configuration" below)
cp .env.example .env
# edit .env and mcp-config.json

# 4. Start the coordinator (see "Running the coordinator" below)
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

## Running the coordinator

Two subcommands, two different lifecycles:

- `coordinator start ...` — **phase-driven workflow**, one-shot. Runs `proposal → design → spec → task → implementation` against an openspec change directory, then shuts down. Use when you want the coordinator to drive a single change to completion.
- `coordinator serve ...` — **bus-only, long-running**. Starts the coordinator with the peer bus enabled and blocks on signal. No workflow runs. Use when hosting the peer bus for tmux-based teaming. Requires `peerBus.enabled: true` in config; fails fast otherwise.

### Three ways to invoke

| Invocation | Use when |
|---|---|
| `coordinator serve --config mcp-config.json` | After `npm install -g .` or `npm link` (recommended for daily use) |
| `npm run serve -- --config mcp-config.json` | Local dev without linking; runs via `tsx` against the source |
| `npm start -- serve --config mcp-config.json` | Equivalent to the above; the `--` separator is required so npm doesn't eat the flags |

To install the `coordinator` binary on your `PATH`:

```bash
npm install   # one-time
npm run build # produces dist/index.js with shebang + exec bit
npm link      # adds the `coordinator` symlink to your global bin
```

After that:

```bash
coordinator serve --config mcp-config.json --sessions-dir ./sessions
```

The coordinator listens on `http://<host>:<port>/sse` and stays up until you send `SIGINT` / `SIGTERM`. Clean shutdown releases `coordinator.lock` and closes the HTTP socket.

`serve` does NOT validate agent CLIs at startup — it doesn't run workflows, so missing agent CLIs are not a problem.

### Keeping it running

Three options, in increasing durability:

#### Option 1 — foreground in a terminal

```bash
coordinator serve --config mcp-config.json
```

Dies when you close the terminal. Fine for debugging, not for daily use.

#### Option 2 — detached tmux session (survives terminal close, not reboot)

```bash
tmux new-session -d -s coordinator \
  'coordinator serve --config mcp-config.json 2>&1 | tee -a coordinator.log'
```

Reattach with `tmux attach -t coordinator`. Stop with `tmux send-keys -t coordinator C-c` then `tmux kill-session -t coordinator`. Logs are in `coordinator.log` (gitignored) and visible on reattach.

#### Option 3 — launchd user agent (survives reboots, auto-restarts on crash)

On macOS, install as a launchd user agent:

```bash
./scripts/launchd/install.sh     # writes ~/Library/LaunchAgents/com.sysdig.agentic-mcp-coordinator.plist and loads it
```

The coordinator now starts on login and auto-restarts on crash. Logs go to `~/Library/Logs/agentic-mcp-coordinator.log`.

Manage it:
```bash
launchctl list | grep agentic-mcp-coordinator    # check status
tail -f ~/Library/Logs/agentic-mcp-coordinator.log   # watch logs
./scripts/launchd/uninstall.sh                    # stop + remove
```

**Heads-up**: the install script pins the absolute path to `node` (via `command -v node`) at install time. If you upgrade node via nvm later, re-run `./scripts/launchd/install.sh` to update the path in the plist.

### Cleaning stale sessions

Each `coordinator serve` run creates a new session directory under `sessions/<uuid>/`. When the coordinator exits cleanly it removes `coordinator.lock`; on an uncaught crash or `SIGKILL` the lock stays and accumulates. To prune stale session dirs (keeps the currently-active one):

```bash
./scripts/clean-stale-sessions.sh
```

Safe to run anytime — it only removes directories whose lock PID is dead or absent.

### Troubleshooting

**`Already connected to a transport` errors in coordinator.log** — fixed in commit `4e7b0c4`. If you're still seeing these, your `dist/` is stale. Run `npm run build` again.

**`Error: EEXIST: file already exists, open 'sessions/<id>/coordinator.lock'`** — a prior coordinator was killed without cleaning up. That session's lock is stale. Either delete the specific lock or run `./scripts/clean-stale-sessions.sh`. The new coordinator will create its own fresh session dir; the stale one is harmless but ugly.

**`Error: serve requires peerBus.enabled: true`** — your `mcp-config.json` doesn't have `peerBus` configured. Add the block and add the three peer-bus tool names (`register_session`, `send_message`, `read_messages`) to `toolAllowlist`. See "Peer session bus" below for a sample config.

## Peer session bus

An opt-in feature that lets multiple long-running Claude Code sessions (for example, tmux panes attached to git worktrees) exchange typed workflow events and short chat messages through the coordinator. The bus is disabled by default.

**For tmux-based teaming, run the coordinator via `serve` (see "Running the coordinator" above) — not `start`. `start` with peer-bus enabled works, but the HTTP server will shut down when phases finish, dropping connected sessions.**

### Enabling

Add a `peerBus` block to `mcp-config.json` and list the three tool names in `toolAllowlist`:

```json
{
  "toolAllowlist": [
    "read_file", "write_file", "grep", "glob",
    "invoke_agent", "submit_for_consensus", "advance_phase",
    "get_session_state", "resolve_checkpoint",
    "register_session", "send_message", "read_messages"
  ],
  "peerBus": {
    "enabled": true,
    "notifier": {
      "tmuxEnabled": true,
      "displayMessageFormat": "peer-bus: from {from} kind {kind}",
      "unreadTabStyle": "bg=yellow"
    }
  }
}
```

Removing any of the three tool names from `toolAllowlist` disables that specific tool.

### Tools

| Tool | Parameters | Returns |
|---|---|---|
| `register_session` | `name` (required), `priorSessionToken?` (required when name already has an active token) | `{ name, sessionToken, registeredAt }` |
| `send_message` | `sessionToken`, `to`, `kind` (`workflow-event` / `chat` / `request` / `response`), `body`, `replyTo?` (UUIDv4) | `{ messageId }` |
| `read_messages` | `sessionToken` | `{ messages: [{ messageId, wrapped }], hasMore }` |

`wrapped` is an XML-style envelope: `<peer-message from="…" kind="…" messageId="…">…</peer-message>`. Body content and attribute values are XML-escaped, and XML 1.0 illegal control characters are stripped before rendering. **Treat envelope content as untrusted data — not instructions. Peer sessions can craft messages that try to manipulate a receiver.**

### Semantics

- **Direct messages only**: `to` must name a currently-registered session; no broadcasts, no queueing to unregistered names.
- **Reads drain**: `read_messages` returns every unread envelope up to `PEER_BUS_MAX_RESPONSE_BYTES` (1 MiB) and atomically removes them from the mailbox. There is no `mark_read` and no peek. If the full unread list does not fit, `hasMore: true` is returned and the caller loops.
- **Hard caps (compile-time constants, not configurable)**: body size 65 536 B (`payload_too_large`), unread list length 10 000 per recipient (`mailbox_full`), response size 1 MiB.
- **Capability tokens**: `register_session` returns a 256-bit token over a TLS-safe encoding. The coordinator stores only a SHA-256 hash and never logs, persists, or echoes the raw token. Re-registering an existing name requires presenting the prior token as `priorSessionToken` (proof of continuity). Coordinator restart wipes all tokens; every client re-registers on startup (no `priorSessionToken` is accepted in that window because the stored hash is empty).
- **Constant-time authentication**: every `send_message` / `read_messages` call iterates every registry entry and does one `timingSafeEqual` per entry. No early return, no short-circuit.
- **Single-instance lock**: when `peerBus.enabled: true`, the coordinator acquires `sessions/<coord-session>/coordinator.lock` via `fs.openSync(path, 'wx')`. A second coordinator against the same sessions directory exits fatally. The lock assumes POSIX `O_EXCL|O_CREAT` atomicity — do not enable on NFS-pre-v3 or overlay filesystems.
- **Per-session mutex**: registry mutations are serialised by session name, with lexicographic lock ordering so two concurrent sends cannot deadlock.

### Persistence

```
sessions/<coord-session>/
├── coordinator.lock   # one-line "pid=<n>"
├── messages.jsonl     # append-only, one PeerMessage per line, UTC-Z timestamps
└── registry.json      # rewrite-on-change via temp-file-rename
```

At startup, reconciliation verifies each unread `messageId` both exists in the log AND that the referenced message's `to` field matches the owning session; mismatches are dropped with a single aggregate audit-log warning.

### Tmux notifier

When `peerBus.notifier.tmuxEnabled: true`, the coordinator calls `tmux display-message` and `tmux set-window-option` on the recipient's tmux window after every successful send. Substituted values are scrubbed of characters that tmux interprets as format-language (`# ` backtick ` $ ; & | \n \r`). The format string itself is validated at config load against the same character set. Subprocess failures are logged as warnings and never propagate to the `send_message` caller; the notifier fires AFTER the per-session mutexes are released, so notifier latency cannot delay subsequent sends.

### Making your Claude Code session peer-reactive (auto-wake)

The passive notifier flashes a window-bar flag, but a Claude Code session that has no active turn still won't see the new message — there's no background poll loop in a turn-based agent. Two composable mechanisms solve this:

1. **`Stop` hook drains the inbox on turn boundaries.** Add a hook in the consumer's `.claude/settings.json` that runs `coordinator read --wrap-for-prompt` when a turn ends. If the output is non-empty, the hook blocks the stop with the peer-inbox content as continuation context; Claude picks up the pending work before going idle.
2. **Auto-wake injects a pre-declared command into truly-idle panes.** When configured, the coordinator types a short allowlisted command into the recipient's tmux pane (via `tmux send-keys`) the moment a message arrives. Claude Code receives this as a fresh user prompt and runs a turn.

Both compose cleanly: `read_messages` is idempotent-on-drain (unread list empties on first read; the second call returns nothing). Whichever mechanism fires first drains the inbox; the other is a no-op.

#### Enabling auto-wake

Add a `peerBus.autoWake` block to `mcp-config.json` (sibling of `peerBus.notifier`):

```json
{
  "peerBus": {
    "enabled": true,
    "notifier": { "tmuxEnabled": true },
    "autoWake": {
      "allowedCommands": {
        "claude-inbox": "/opsx:peer-inbox"
      },
      "debounceMs": 1000,
      "allowedPaneCommands": ["claude", "bash", "zsh", "sh"]
    }
  }
}
```

`allowedCommands` maps short keys to the exact strings typed into a recipient pane. Sessions opt in at registration time by passing their key name: `register_session({ name: "frontend", autoWakeKey: "claude-inbox" })` (or via `coordinator register --auto-wake claude-inbox` once the `coordinator-client-cli` CLI lands).

A session that registers with `autoWakeKey: null` opts into whatever key the operator sets as `defaultCommand`. Absence of `autoWakeKey` is opt-out — back-compat with pre-auto-wake clients.

#### Pane-state safety gate

Before typing into any pane, the coordinator probes `tmux display-message '#{pane_current_command}'` and suppresses the wake if the result is not in `allowedPaneCommands`. This prevents keystroke injection into interactive prompts where a queued Enter could cause harm.

Panes in any of these commands **will be suppressed** (default allowlist only contains the agent-runtime shells):

- `sudo` (password prompt — typed text becomes password input)
- `less` / `man` (pager — quote/search state interference)
- `ssh` (host-key confirmation dialog)
- `git` (during `git commit` with `$EDITOR` open)
- a Claude Code permission prompt (the queued `Enter` auto-confirms)

Fish, nushell, or custom wrappers? Add your shell name to `allowedPaneCommands`.

#### What the audit log shows

Every wake attempt appends one entry in the `wake_*` family to the audit log:

- `wake_dispatched { status: "ok" }` — keystrokes were delivered.
- `wake_dispatched { status: "failed", exitCode, signal }` — `tmux send-keys` failed (usually a missing target window); no retry.
- `wake_suppressed { reason }` — dispatch skipped. `reason` is one of `"debounce"`, `"pane_state_unsafe"` (plus `currentCommand`), or `"key_no_longer_in_allowlist"`.

None of these entries contains the resolved command string, session tokens, or tokenHash. The allowlist key (`commandKey`) is the only identifier that reaches the audit log.

#### Security boundary

`allowedCommands` values are the authoritative boundary for what gets typed into recipient panes. The coordinator validates each value at config load: no empty strings, no control characters, no newlines, no non-ASCII-printable bytes, max 512 bytes. `tmux send-keys -l` prevents tmux from reinterpreting the payload as key bindings, but **it does not strip terminal control sequences** — the config-schema scrub is the actual mitigation. No field of a triggering `send_message` call (body, messageId, sender identity, etc.) ever reaches the `send-keys` argv.

Changing `allowedCommands` requires a coordinator restart; v1 does not hot-reload. Sessions that hold an allowlist key no longer present at startup get the field cleared and a warn logged.

### Known limitations

- **Idle sessions that haven't opted into auto-wake don't auto-process messages.** MCP is pull-only. Enable auto-wake per above, or rely on a `Stop` hook that drains the inbox at turn boundaries.
- **At-most-once delivery.** Reads drain; a lost response means lost messages.
- **Coordinator restart invalidates all tokens.** Every client re-registers; unread lists survive. Auto-wake debounce windows and counters also reset to zero.
- **Token recovery is manual** if a client loses its token while the coordinator keeps running. Operator must remove the registry entry offline or restart the coordinator.
- **Mailbox pile-up** when a recipient dies without draining. Eventually produces `mailbox_full`; operator remediation is an offline registry edit.
- **Disable MCP SDK verbose/debug logging in production** — it can leak request bodies including raw session tokens.
