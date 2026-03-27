# Architecture

## MCP as the coordination bus

The coordinator is itself an MCP server. Every interaction in the system — filesystem tools, agent invocations, workflow control, consensus decisions — is performed as an MCP tool call on this single server. There are no separate channels or direct API calls outside of the tools the coordinator exposes.

This means:

- **One protocol for everything.** Tool access, agent triggers, and workflow management all speak MCP. Any MCP-capable client (Claude, a human CLI, a future agent) can connect and participate.
- **Unified audit trail.** Every tool call flows through the server and is logged to the session audit log before the coordinator responds.
- **Composable by design.** Adding a new participant or tool means registering it on the coordinator's MCP server — no new integration surfaces.

## Tool categories

The coordinator exposes up to 11 tools in three groups:

### 1. Shared tools

Standard filesystem tools available to authorized clients, plus an optional execution tool when explicitly enabled:

| Tool | Description |
|---|---|
| `read_file` | Read a file relative to `rootDir` |
| `write_file` | Write a file relative to `rootDir` |
| `grep` | Search file contents by pattern |
| `glob` | List files matching a glob pattern |
| `bash` | Execute a shell command with a 30-second timeout (opt-in only) |

All paths are validated against `rootDir` using the resolved filesystem target, so both path traversal and symlink escapes are rejected. Tools not in `toolAllowlist` return an error.

## Transport trust boundary

The MCP HTTP transport binds to `127.0.0.1` by default. If you intentionally bind it more broadly, you must configure a transport auth token; unauthenticated clients are rejected before they can establish an MCP session.

### 2. Agent trigger tools

A single generic tool dispatches to any registered agent:

| Tool | Description |
|---|---|
| `invoke_agent` | Look up `agentId` in the registry, apply spawn guardrails, invoke the configured CLI, and return an `AgentMessage` |

The registry (loaded from `mcp-config.json → agents`) maps agent IDs to CLI commands and capability flags. Agents that don't natively speak MCP receive snapshot context as labeled prompt blocks. Spawn guardrails enforce a depth limit, per-session invocation budget, and concurrent cap for delegated calls.

### 3. Workflow tools

Drive and inspect the coordination workflow:

| Tool | Description |
|---|---|
| `submit_for_consensus` | Submit an artifact to the consensus loop; returns the outcome |
| `advance_phase` | Advance to the next workflow phase (requires a terminal artifact outcome) |
| `get_session_state` | Return the current session state JSON |
| `resolve_checkpoint` | Record a human `proceed` or `abort` decision |

## Consensus round — message flow

```
Coordinator
    │
    ├─ capture review snapshot (artifact + tool outputs)
    │
    ├─── invoke_agent(reviewer-1) ──────────────────────────────►  Agent CLI
    ├─── invoke_agent(reviewer-2) ──────────────────────────────►  Agent CLI   (parallel)
    ├─── invoke_agent(reviewer-N) ──────────────────────────────►  Agent CLI
    │    (all N reviewers run concurrently via Promise.all)
    │◄─── all AgentMessages collected ───────────────────────────
    │
    ├─ evaluateConsensus(msgs[])
    │
    ├─ if all approve       → consensus-reached → advance_phase
    ├─ if any blocks        → resolve_checkpoint (human)
    ├─ if request-changes   → aggregateFeedback → invoke_agent(reviser) → next round
    └─ if cap reached       → resolve_checkpoint (human)
```

Key invariant: all agents review **the same review snapshot** for a given round. The snapshot is captured once, persisted to disk, and reused for every `invoke_agent` call in the round. This ensures every reviewer evaluated identical tool outputs — not separate reads that could differ.

## Independent first-pass review

Before any feedback is shared between agents, all reviewers independently review the same artifact snapshot in parallel. Only after all responses are collected does the coordinator evaluate consensus. This prevents any agent from anchoring another's initial assessment.

If any reviewer requests changes, the reviser agent produces a revised artifact. The revision prompt includes aggregated feedback from all reviewers that requested changes, with per-agent content sections and a 2048-character truncation limit.

## Consensus vs human-approved

The coordinator distinguishes two terminal outcomes:

- **`consensus-reached`** — both agents approved the same artifact revision.
- **`human-approved`** — the human operator explicitly advanced the workflow after a deadlock, block, or revision cap.

Both outcomes allow the workflow to advance via `advance_phase`, but the distinction is preserved in session state and the audit log. This keeps the audit trail truthful about how each artifact was resolved.

## Workflow phases

```
proposal → design → spec → task → implementation
```

Consensus (or human approval) is required at each boundary. After the task phase, the coordinator assigns each task to a primary agent and a reviewing agent, then enters the implementation phase.

## Git worktrees for implementation isolation

During the implementation phase, each task runs in its own Git worktree:

1. Coordinator records the current HEAD as the task's base commit.
2. A new branch and worktree are created from that base.
3. The primary agent returns a unified diff patch and commit message.
4. The coordinator applies the patch inside the worktree and commits it.
5. The reviewing agent reviews the diff. If changes are requested, the coordinator resets the worktree, generates a revised patch, and re-reviews.
6. After approval, the task branch is merged into the session branch sequentially.
7. If the merge conflicts (session branch moved), the coordinator rebases the task branch onto the current session head in the worktree, regenerates the diff, and requires re-review before merge.

This means no two tasks write to the same live checkout simultaneously — isolation is provided by the filesystem, not by locking.
