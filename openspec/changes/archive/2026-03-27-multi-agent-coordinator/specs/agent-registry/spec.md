## ADDED Requirements

### Requirement: Coordinator loads a named agent registry from configuration
The coordinator SHALL load an `agents` map from `mcp-config.json` at startup, where each key is an agent ID and each value declares the CLI path, an optional specialty description, and capability flags controlling whether the agent may review artifacts, revise artifacts, implement tasks, and invoke other agents. The coordinator SHALL validate that every declared CLI is present in PATH before any workflow phase begins.

#### Scenario: Registry loaded successfully
- **WHEN** the coordinator starts and `mcp-config.json` contains a valid `agents` map with at least one entry
- **THEN** the coordinator SHALL register all agents, validate each CLI is in PATH, and log a `registry_loaded` audit entry listing all agent IDs

#### Scenario: Unknown CLI at startup
- **WHEN** an agent entry in the registry declares a `cli` value that is not found in PATH
- **THEN** the coordinator SHALL exit with a descriptive error naming the missing CLI before starting the MCP server

#### Scenario: Empty registry
- **WHEN** `mcp-config.json` contains an `agents` map with zero entries
- **THEN** the coordinator SHALL exit with an error indicating at least one agent is required

#### Scenario: No revising or implementing agent configured
- **WHEN** the registry contains no agent with `canRevise: true` or no agent with `canImplement: true`
- **THEN** the coordinator SHALL exit with a descriptive configuration error before starting the MCP server

### Requirement: Each agent entry declares a specialty injected into its system prompt
The coordinator SHALL prepend the agent's `specialty` value to the system prompt for every invocation of that agent, so the agent is aware of its intended role in the workflow.

#### Scenario: Specialty injected
- **WHEN** `invoke_agent` is called for an agent whose registry entry includes a non-empty `specialty`
- **THEN** the full prompt sent to the CLI SHALL include the specialty as a preamble before the workflow system prompt

#### Scenario: No specialty declared
- **WHEN** an agent entry omits `specialty` or sets it to an empty string
- **THEN** the coordinator SHALL use the default workflow system prompt without a specialty preamble

### Requirement: Agent registry controls which agents may invoke other agents
Each agent entry SHALL include an `allowSubInvocation` boolean. Agents with `allowSubInvocation: false` SHALL NOT be permitted to call `invoke_agent` via MCP. If omitted, `allowSubInvocation` SHALL default to `false`.

#### Scenario: Sub-invocation allowed
- **WHEN** an agent with `allowSubInvocation: true` calls `invoke_agent` via MCP during its own turn
- **THEN** the coordinator SHALL process the call subject to all other spawning guardrails

#### Scenario: Sub-invocation blocked by registry
- **WHEN** an agent with `allowSubInvocation: false` calls `invoke_agent` via MCP
- **THEN** the coordinator SHALL reject the call with an MCP error, log a `spawn_rejected` audit entry with reason `"sub-invocation-not-permitted"`, and return the error to the calling agent without escalating to a human checkpoint

### Requirement: Agent registry declares phase-relevant capabilities
Each agent entry SHALL include `canReview`, `canRevise`, and `canImplement` booleans. Review rounds SHALL use only agents with `canReview: true`; revision routing SHALL target only agents with `canRevise: true`; implementation task assignment SHALL choose only agents with `canImplement: true`.

#### Scenario: Reviewer-only specialist excluded from implementation
- **WHEN** an agent is configured with `canReview: true` and `canImplement: false`
- **THEN** the coordinator SHALL include that agent in review rounds but SHALL NOT assign it as a task primary or implementation reviser
