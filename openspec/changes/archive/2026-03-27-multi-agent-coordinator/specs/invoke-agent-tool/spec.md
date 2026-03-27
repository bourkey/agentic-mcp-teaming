## ADDED Requirements

### Requirement: Coordinator exposes a single generic `invoke_agent` MCP tool
The coordinator MCP server SHALL expose one tool named `invoke_agent` accepting `agentId`, `prompt`, optional `context`, and an `invocationContext` object (`invocationId`, `parentInvocationId`, `depth`). All agent invocations — whether initiated by the coordinator loop or by another agent — SHALL use this tool exclusively.

#### Scenario: Coordinator-initiated invocation
- **WHEN** the workflow loop calls `invoke_agent` with a registered `agentId` and no `parentInvocationId`
- **THEN** the coordinator SHALL treat it as a root-level invocation (`depth: 1`), assign a new `invocationId`, spawn the agent CLI, and return an `AgentMessage` as the tool result

#### Scenario: Agent-initiated sub-invocation
- **WHEN** an agent calls `invoke_agent` via MCP during its own turn, supplying its own `invocationId` as `parentInvocationId`
- **THEN** the coordinator SHALL increment `depth` by one, assign a new `invocationId`, enforce all spawning guardrails, and if permitted, spawn the target CLI and return the result

#### Scenario: Invocation logged with call-tree IDs
- **WHEN** any `invoke_agent` call completes
- **THEN** the coordinator SHALL append an `agent_invocation` audit log entry containing: `invocationId`, `parentInvocationId`, `depth`, `agentId`, `phase`, `artifactId`, `round`, `action`, and `content`

### Requirement: Eligible agents receive coordinator transport details for sub-invocation
Agents with `allowSubInvocation: true` SHALL be launched with enough coordinator connection context to call `invoke_agent` back through the parent coordinator during their turn. Agents without that permission SHALL not receive transport details.

#### Scenario: Delegation-enabled agent launched
- **WHEN** the coordinator spawns an agent whose registry entry has `allowSubInvocation: true`
- **THEN** the coordinator SHALL inject the MCP server URL, any required auth token reference, and the current `invocationContext` into the child process environment and/or prompt context

#### Scenario: Delegation-disabled agent launched
- **WHEN** the coordinator spawns an agent whose registry entry has `allowSubInvocation: false`
- **THEN** the coordinator SHALL omit coordinator transport details from the child process environment and prompt context

### Requirement: `invoke_agent` replaces `invoke_claude` and `invoke_codex`
The MCP server SHALL NOT register `invoke_claude` or `invoke_codex` tools. Any workflow logic that previously called those tools SHALL call `invoke_agent` with the appropriate `agentId` from the registry.

#### Scenario: Old tool name rejected
- **WHEN** an MCP client sends a tool call for `invoke_claude` or `invoke_codex`
- **THEN** the MCP server SHALL return a standard "unknown tool" error response

### Requirement: `invoke_agent` injects snapshot context for agents that do not natively speak MCP
For agents whose CLI does not natively connect to the MCP server (e.g. Codex), the coordinator SHALL collect the relevant review snapshot tool results and inject them as labeled context blocks into the prompt before spawning the CLI subprocess, preserving the existing context-injection behaviour.

#### Scenario: Context blocks injected for non-MCP agent
- **WHEN** `invoke_agent` is called for an agent with `snapshotContext` supplied
- **THEN** the coordinator SHALL prepend the snapshot context as `## Shared Context\n\n### Tool: <name>\n...\` blocks before the prompt body
