## ADDED Requirements

### Requirement: Coordinator initializes a teaming session
The coordinator SHALL initialize a session with a unique ID, load agent CLI configuration, and verify the configured agent CLIs are available in PATH before any workflow phase begins.

#### Scenario: Successful session initialization
- **WHEN** the coordinator is started with the `claude` and `codex` CLIs available in PATH
- **THEN** a session is created with a unique ID and the coordinator logs the session start with a timestamp

#### Scenario: Missing CLI
- **WHEN** a configured agent CLI (e.g. `claude` or `codex`) is not found in PATH
- **THEN** the coordinator SHALL exit with a descriptive error before attempting any agent communication

### Requirement: Coordinator routes artifacts to agents via MCP tool calls
The coordinator SHALL route artifacts to agents exclusively through the `invoke_claude` and `invoke_codex` MCP tools exposed on the coordinator MCP server. The turn order is deterministic (Claude first, then Codex by default). Both invocations SHALL be sequential — the coordinator SHALL never call both agent trigger tools concurrently.

#### Scenario: Turn-based artifact routing via MCP
- **WHEN** an artifact is submitted to the consensus loop
- **THEN** the coordinator SHALL create a review snapshot for the artifact revision, call `invoke_claude` with that snapshot, await the MCP tool result, then call `invoke_codex` with the same snapshot, and collect both initial responses before evaluating consensus or sharing either agent's feedback for a revision round

#### Scenario: Agent trigger tool timeout
- **WHEN** an `invoke_claude` or `invoke_codex` MCP tool call does not return within the configured timeout (default: 120 seconds)
- **THEN** the coordinator SHALL log a warning to the audit log, call `resolve_checkpoint` to escalate to a human checkpoint, and pause the workflow

### Requirement: Coordinator maintains shared session state
The coordinator SHALL maintain a state object per session tracking the current phase, artifact versions, review outcome per artifact, review snapshot IDs, revision round counts, and implementation branch/worktree metadata.

#### Scenario: State persisted between phases
- **WHEN** the workflow advances from one phase to the next
- **THEN** the coordinator SHALL write the updated session state to a local `sessions/<session-id>/state.json` file before invoking any agent in the new phase

#### Scenario: Session resume after interruption
- **WHEN** the coordinator is restarted with an existing session ID
- **THEN** it SHALL load the state from `sessions/<session-id>/state.json` and resume from the last incomplete phase

### Requirement: Coordinator emits a structured audit log
The coordinator SHALL append every agent message, coordinator action, and human decision to a newline-delimited JSON audit log at `sessions/<session-id>/audit.log`.

#### Scenario: Audit log entry on every agent turn
- **WHEN** an agent submits a response
- **THEN** the coordinator SHALL append a JSON entry containing: session ID, timestamp, agent role, phase, action, artifact ID, round number, and message content

#### Scenario: Audit log is append-only
- **WHEN** any workflow event occurs
- **THEN** existing audit log entries SHALL NOT be modified or deleted; only new entries are appended
