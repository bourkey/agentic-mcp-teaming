## 1. Project Bootstrap

- [x] 1.1 Initialize Node.js/TypeScript project with `package.json`, `tsconfig.json`, and `.env.example`
- [x] 1.2 Add dependencies: `@modelcontextprotocol/sdk`, `zod`, `commander` (no SDK API clients needed — agent invocations use CLI subprocesses)
- [x] 1.3 Create project directory structure: `src/`, `sessions/`, `openspec/`
- [x] 1.4 Configure ESLint and TypeScript strict mode

## 2. Message Schema

- [x] 2.1 Define and export the `AgentMessage` Zod schema (version, role, phase, action, content, artifactId, round)
- [x] 2.2 Define `ConsensusAction` enum: `approve`, `request-changes`, `block`
- [x] 2.3 Define `WorkflowPhase` enum: `proposal`, `design`, `spec`, `task`, `implementation`, `review`
- [x] 2.4 Write unit tests for schema validation covering all valid and invalid shapes

## 3. Coordinator MCP Server — Shared Tools

- [x] 3.1 Implement coordinator MCP server using `@modelcontextprotocol/sdk` (server mode)
- [x] 3.2 Register shared tools on the MCP server: `read_file`, `write_file`, `grep`, `glob`, and opt-in `bash`
- [x] 3.3 Load server config (port, tool allowlist, root dir, agent model IDs) from `mcp-config.json`
- [x] 3.4 Write integration tests verifying each shared tool returns expected output for a known fixture
- [x] 3.5 Implement review snapshot capture and persistence for artifact review rounds
- [x] 3.6 Harden shared filesystem tools against symlink escapes outside `rootDir`

## 4. Coordinator MCP Server — Agent Trigger Tools

- [x] 4.1 Implement `invoke_claude` MCP tool: accepts prompt + context, spawns `claude -p "<prompt>"` CLI subprocess, returns `AgentMessage`
- [x] 4.2 Implement `invoke_codex` MCP tool: collects relevant shared tool results, injects as labeled context blocks into prompt, spawns `codex "<prompt>"` CLI subprocess, returns `AgentMessage`
- [x] 4.3 Add configurable timeout (default 120s) to both agent trigger tools; return MCP error response on timeout
- [x] 4.4 Write unit tests for both agent trigger tools using mocked API and MCP responses

## 5. Coordinator MCP Server — Workflow Tools

- [x] 5.1 Implement `submit_for_consensus` MCP tool: accepts artifact ID and content, enters the consensus loop, returns consensus result
- [x] 5.2 Implement `advance_phase` MCP tool: validates a terminal review outcome (`consensus-reached` or `human-approved`), writes state, returns new phase name
- [x] 5.3 Implement `get_session_state` MCP tool: returns current session state JSON
- [x] 5.4 Implement `resolve_checkpoint` MCP tool: accepts `proceed` or `abort`, records human decision, unblocks or halts workflow
- [x] 5.5 Write unit tests for all workflow tools covering valid transitions and invalid state errors

## 6. Coordinator Core

- [x] 6.1 Implement `SessionManager`: create, load, and persist session state to `sessions/<id>/state.json`
- [x] 6.2 Implement `AuditLogger`: append-only newline-delimited JSON writes to `sessions/<id>/audit.log`; hook into MCP server to log every tool invocation automatically
- [x] 6.3 Implement turn-based routing via `invoke_claude` / `invoke_codex` MCP tool calls — never call agent APIs directly
- [x] 6.4 Implement consensus evaluator: distinguishes `consensus-reached` from `human-approved` and checks whether both agents approved the same artifact revision
- [x] 6.5 Write unit tests for session state transitions and consensus evaluation logic

## 7. Consensus Loop

- [x] 7.1 Implement consensus loop with revision cap (max 3 rounds per artifact) using `submit_for_consensus` tool
- [x] 7.2 Implement independent first-pass review: collect Claude and Codex responses on the same snapshot before sharing feedback crosswise
- [x] 7.3 Implement `request-changes` handling: pass prior round history to originating agent for revision via `invoke_claude`/`invoke_codex`
- [x] 7.4 Implement `block` handling: immediately call `resolve_checkpoint` to escalate to human
- [x] 7.5 Implement revision round history injection: include all prior feedback in re-review prompt
- [x] 7.6 Write integration tests for consensus loop covering: first-round approval, multi-round resolution, cap escalation, block escalation, and human override state

## 8. Human Checkpoints

- [x] 8.1 Implement CLI human checkpoint: display consensus summary and await `resolve_checkpoint` call with `proceed` / `abort`
- [x] 8.2 Add pre-phase transition checkpoints between all major phases (triggered via `advance_phase` tool)
- [x] 8.3 Add escalation checkpoint for revision cap exceeded and agent blocks
- [x] 8.4 Log human decisions to audit log via `AuditLogger` with timestamp, decision value, and resulting artifact outcome (`human-approved` or `aborted`)

## 9. Workflow Phases

- [x] 9.1 Implement `ProposalPhase`: call `submit_for_consensus` for proposal artifact
- [x] 9.2 Implement `DesignPhase`: call `submit_for_consensus` for design artifact
- [x] 9.3 Implement `SpecsPhase`: call `submit_for_consensus` for each spec artifact (one per capability)
- [x] 9.4 Implement `TasksPhase`: call `submit_for_consensus` for tasks artifact, then produce task assignment via `invoke_claude`/`invoke_codex`
- [x] 9.5 Implement `ImplementationPhase`: per-task assign → create task branch/worktree from recorded base commit → collect agent-produced patch + commit message → apply patch in worktree → `invoke_*` review loop → sequential Git integration into the session branch
- [x] 9.6 Implement task scope tracking and merge-queue rules so only compatible tasks run concurrently
- [x] 9.7 Implement review-change handling so reviewer feedback triggers a revised patch, worktree reset, and regenerated diff before the next review round
- [x] 9.8 Implement conflict handling for merge/rebase failures, including rebasing the task branch onto the session branch in the task worktree and forcing re-review when an approved task is replayed onto a newer base

## 10. CLI Entry Point

- [x] 10.1 Implement `npm start` CLI using `commander`: accepts `--workflow`, `--session`, `--dry-run` flags
- [x] 10.2 Implement `--dry-run` mode: register mock `invoke_claude`/`invoke_codex` tools on the MCP server that return fixture responses
- [x] 10.3 Add `--session <id>` flag to resume an interrupted session by calling `get_session_state` at startup
- [x] 10.4 Print usage help and validate required env vars on startup; check `mcp-config.json` exists
- [x] 10.5 Validate Git availability and repository cleanliness rules needed for worktree-based execution on startup
- [x] 10.6 Bind MCP HTTP transport to loopback by default and require an auth token when a broader host binding is configured

## 11. End-to-End Testing

- [x] 11.1 Write an end-to-end test using `--dry-run` mode that runs the full workflow from proposal to implementation via MCP tool calls
- [x] 11.2 Verify audit log contains an entry for every MCP tool call (shared tools, agent triggers, workflow tools, and human decisions)
- [x] 11.3 Verify session state is correctly written via `advance_phase` and loadable for resume via `get_session_state`
- [x] 11.4 Verify both agents receive equivalent shared tool results for the same artifact
- [x] 11.5 Verify concurrent tasks execute in separate Git worktrees and integrate sequentially into the session branch
- [x] 11.6 Verify implementation patch application, reviewer-requested revisions, and conflict replay behavior with real Git worktrees
- [x] 11.7 Verify unauthorized MCP transport requests are rejected and symlink escapes are blocked

## 12. Documentation

- [x] 12.1 Write `readme.md`: prerequisites, installation (`npm install`), environment setup (`.env`, `mcp-config.json`), quickstart (dry-run), full-workflow usage, CLI flag reference, and troubleshooting
- [x] 12.2 Write `docs/architecture.md`: MCP coordination bus rationale, three tool categories (shared/agent-trigger/workflow), ASCII message-flow diagram for a consensus round, phase sequence, independent first-pass review model, consensus-reached vs human-approved distinction
- [x] 12.3 Write `docs/tools.md`: all 11 MCP tools grouped by category — each with description, input parameter schema (name, type, required/optional), return value structure, and an example invocation
- [x] 12.4 Write `docs/session-format.md`: `state.json` field-by-field reference, complete list of audit log entry types with their fields and meaning, session resume walkthrough using `--session <id>`
