## Context

Claude (via the Claude Code CLI) and Codex (via the Codex CLI) are both capable coding agents but currently operate independently. This project introduces a coordinator layer that lets them collaborate: sharing context over MCP, negotiating on artifacts through a consensus protocol, and jointly implementing code. The system runs locally within the IDE context — no API keys or cloud infrastructure required; both CLIs use existing IDE authentication.

## Goals / Non-Goals

**Goals:**
- Coordinator process that mediates turn-based communication between Claude and Codex
- MCP server providing both agents with shared access to filesystem, search, and code execution tools
- Consensus protocol: each artifact (proposal, design, spec, task, code) must be approved by both agents before the workflow advances
- Human-in-the-loop checkpoints at key phases (post-consensus, pre-implementation, post-implementation)
- Structured message schema for agent-to-agent communication (JSON over stdio or HTTP)
- Audit log of all agent turns, proposals, and consensus decisions
- Git-backed task isolation using branches and worktrees so implementation can proceed without both agents writing into the same checkout

**Non-Goals:**
- Real-time parallel execution of both agents simultaneously (turn-based only, for determinism)
- GUI or web interface (CLI-first)
- Support for agents beyond Claude and Codex in this iteration
- Cloud deployment or multi-user support

## Decisions

### 1. Coordinator as an MCP server

**Decision:** The coordinator is itself an MCP server. All interactions — tool calls, agent triggers, workflow control, and consensus operations — are exposed as MCP tools on this single server. Claude, Codex (via proxy), and the human CLI all connect to the coordinator as MCP clients.

**Rationale:** Using MCP as the coordination bus means one protocol for everything: tools, agent invocation, and workflow management. This avoids separate communication channels (direct API for agents, MCP for tools) and makes the system composable — any MCP-capable client can participate in or observe the workflow.

**Alternatives considered:**
- Coordinator as a plain process calling APIs directly: simpler to start, but creates two separate integration surfaces (MCP for tools, HTTP/SDK for agents). Harder to extend and observe.
- Python coordinator: viable, but the MCP SDK has stronger Node.js support for both server and client usage.

### 2. MCP as the coordination bus

**Decision:** The coordinator MCP server exposes three categories of tools:
1. **Shared tools** — `read_file`, `write_file`, `grep`, `glob`, `bash`: standard filesystem and execution tools available to both agents.
2. **Agent trigger tools** — `invoke_claude`, `invoke_codex`: the coordinator accepts a prompt and context, calls the respective agent API, and returns the structured `AgentMessage` response. Agents are invoked exclusively through these tools.
3. **Workflow tools** — `submit_for_consensus`, `advance_phase`, `get_session_state`, `resolve_checkpoint`: workflow control surface for the coordinator loop and human CLI.

Claude connects to the coordinator MCP server via its standard MCP config. Codex, which does not natively speak MCP, is invoked by the coordinator's `invoke_codex` tool, which injects shared tool results into its prompt before calling the Codex API. All tool calls flow through the MCP server and are logged uniformly.

**Rationale:** A single MCP server as the coordination bus means every interaction is observable and auditable through one interface. Tool results, agent turns, and workflow transitions all appear as MCP tool calls in the session log.

**Alternatives considered:**
- Separate MCP server for tools + direct API for agents: splits concerns but creates two integration surfaces and loses the unified audit trail.
- Agents as individual MCP servers: requires each agent to run its own MCP server, which is not natively supported by either provider today.

### 3. Turn-based consensus protocol with independent first-pass review

**Decision:** The consensus loop works as follows:
1. Coordinator creates a review snapshot for the artifact revision, including the artifact content and any shared tool outputs needed for review.
2. Coordinator presents the same snapshot to Claude and Codex for independent first-pass review.
3. Each agent responds with: `approve`, `request-changes` (with comments), or `block` (with reason).
4. If either agent responds with `request-changes`, the originating agent revises the artifact and the coordinator creates a new snapshot for the next round; prior feedback is shared only after both first-pass responses are captured.
5. Both agents must `approve` the same artifact revision for consensus to be reached.
6. Human checkpoint: coordinator pauses and displays consensus summary before advancing.

**Rationale:** Independent first-pass review preserves genuine cross-validation while still allowing deterministic orchestration. Requiring both agents to approve the same snapshot prevents one agent from anchoring the other before an initial assessment. Capping revision rounds prevents infinite loops.

**Alternatives considered:**
- Majority-vote with human as third voter: over-engineered for two agents.
- Async parallel review: harder to reason about, higher risk of conflicting edits.

### 4. Structured JSON message schema

**Decision:** All agent communication uses a versioned JSON envelope:
```json
{
  "version": "1",
  "role": "claude" | "codex" | "coordinator" | "human",
  "phase": "proposal" | "design" | "spec" | "task" | "implementation" | "review",
  "action": "submit" | "approve" | "request-changes" | "block" | "implement" | "comment",
  "content": "...",
  "artifactId": "...",
  "round": 1
}
```

**Rationale:** A typed schema makes the coordinator logic straightforward to implement and the audit log easy to parse. Versioning allows future evolution without breaking existing logs.

### 5. Distinguish consensus from human override

**Decision:** The coordinator records separate terminal outcomes for artifact review:
- `consensus-reached`: both agents approved the same artifact revision
- `human-approved`: the human operator explicitly advanced the workflow after a deadlock, block, or timeout

Workflow transitions may proceed from either terminal state, but audit logs and session state preserve which path occurred.

**Rationale:** Human intervention is materially different from two-agent agreement. Preserving that distinction keeps the audit trail truthful and lets later workflow steps apply different policies if needed.

### 6. Workflow phases align with openspec artifacts

**Decision:** The coordinator workflow phases map directly to openspec phases: proposal → design → specs → tasks → implementation. Consensus is required at the boundary of each phase.

**Rationale:** This project uses openspec itself for its own development. Aligning the teaming workflow with openspec phases means the tooling is self-consistent and the agents operate on the same artifact model used to design them.

### 7. Git worktrees as the implementation isolation boundary

**Decision:** Implementation work is isolated with Git branches and worktrees rather than by applying a batch of file writes directly into the shared working directory.
1. The coordinator creates a session branch for the workflow.
2. For each implementation task, the coordinator records a base commit, creates a task branch without checking it out in the shared checkout, and then attaches a dedicated worktree to that branch.
3. The primary agent does not write directly to disk. Instead, it returns a complete patch and commit message for the task, and the coordinator applies that patch inside the task worktree and creates the commit locally.
4. If the reviewer requests changes, the coordinator asks the primary agent for a revised full patch, resets the task worktree back to the task base, reapplies the revised patch, and regenerates the task diff before the next review round.
5. The reviewing agent reviews the resulting diff or commit set.
6. After approval, the coordinator integrates the task branch back into the session branch sequentially.
7. If integration fails because the session branch has moved, the coordinator rebases the task branch onto the current session branch head in the task worktree, regenerates the diff, and requires re-review before merge. If the rebase conflicts, the coordinator pauses for human resolution.

**Rationale:** Worktrees provide isolated filesystem state per task while Git provides durable state, rollback, and integration semantics. This avoids the need for impossible multi-file atomic writes in a single live checkout.

### 8. Documentation ships with the code

**Decision:** All documentation lives in the repository: `readme.md` at the root (primary entry point), and reference docs under `docs/` (`architecture.md`, `tools.md`, `session-format.md`). No external wiki or hosted docs site.

**Rationale:** The system has three distinct audiences — operators running sessions, developers extending the coordinator, and anyone parsing audit logs. Keeping docs co-located with code ensures they stay in sync as the implementation evolves, can be reviewed in the same PRs as code changes, and are available immediately on checkout without additional steps. The tool reference is especially critical given 11 MCP tools with non-obvious parameter contracts.

**Alternatives considered:**
- External wiki (Confluence, Notion): drifts from code, requires separate access, not version-controlled alongside implementation.
- Inline JSDoc only: insufficient for operators who don't read source code and for architectural context that spans multiple files.

## Risks / Trade-offs

- **Codex API latency and cost** → Mitigation: cache agent responses per artifact hash; allow dry-run mode using mock responses for development.
- **Agents may deadlock on consensus** (both requesting changes indefinitely) → Mitigation: hard cap of 3 revision rounds per artifact; escalate to human if cap is reached.
- **Context window limits** → Mitigation: coordinator summarizes prior turns before injecting into each new agent prompt; full history stored in audit log, not in prompt.
- **MCP tool proxying may diverge from native MCP behavior** → Mitigation: coordinator materializes review snapshots so both agents inspect the same captured tool outputs for a given round.
- **CLI availability** → Mitigation: coordinator validates that `claude` and `codex` CLIs are present in PATH at startup and exits with a descriptive error if either is missing.
- **Concurrent implementation may produce merge conflicts** → Mitigation: assign file/module ownership where possible, pin each task to a base commit, and integrate approved branches through a merge queue with conflict escalation.

## Migration Plan

This is a greenfield project; no migration is needed. Initial deployment steps:
1. Bootstrap coordinator with `npm install`. Ensure `claude` and `codex` CLIs are in PATH and authenticated via your IDE.
2. Start MCP server locally.
3. Run coordinator CLI: `npm start -- --workflow proposal` to begin the first teaming session.
4. Rollback: stop the coordinator process; no persistent state is written outside the local `sessions/` directory.

## Open Questions

- Should the coordinator support a "solo mode" where only one agent participates (for testing/debugging without consuming both APIs)?
- What is the right UX for human checkpoints — interactive CLI prompts, or a simple web UI served locally?
- Should consensus logs be stored in a format compatible with openspec's audit trail, or as a separate artifact?
