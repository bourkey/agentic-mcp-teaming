## MODIFIED Requirements

### Requirement: Coordinator initializes a teaming session
The coordinator SHALL initialize a session with a unique ID, load and validate the agent registry (CLI availability in PATH, at least one agent declared, at least one revising agent, at least one implementing agent), and initialize session-level spawn tracking counters before any workflow phase begins.

#### Scenario: Successful session initialization
- **WHEN** the coordinator is started with the agent CLIs for all registry entries available in PATH
- **THEN** a session is created with a unique ID, spawn counters initialized to zero, and the coordinator logs a `session_start` audit entry listing all registered agent IDs

#### Scenario: Missing CLI
- **WHEN** a configured agent's `cli` value is not found in PATH
- **THEN** the coordinator SHALL exit with a descriptive error naming the agent ID and missing CLI before starting the MCP server

#### Scenario: Empty registry
- **WHEN** the `agents` map in `mcp-config.json` is empty
- **THEN** the coordinator SHALL exit with an error before starting the MCP server

### Requirement: Coordinator routes artifacts to agents via `invoke_agent` MCP tool calls
The coordinator SHALL route all artifact invocations exclusively through the `invoke_agent` MCP tool using agent IDs from the registry. The set of reviewer agents for each phase MAY be configurable per phase; if not configured, all agents with `canReview: true` participate in review. Invocations for the same review round SHALL be issued concurrently.

#### Scenario: Turn-based artifact routing via MCP
- **WHEN** an artifact is submitted to the consensus loop
- **THEN** the coordinator SHALL create a review snapshot, call `invoke_agent` concurrently for all reviewer agent IDs, await all results, then evaluate consensus before sharing any agent's feedback

#### Scenario: Agent trigger tool timeout
- **WHEN** an `invoke_agent` call does not return within the configured timeout (default: 120 seconds)
- **THEN** the coordinator SHALL treat the timed-out agent as having blocked, log an `agent_error` audit entry, and escalate to a human checkpoint
