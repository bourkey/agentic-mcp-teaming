## MODIFIED Requirements

### Requirement: Coordinator exposes agent trigger tools
The coordinator MCP server SHALL expose exactly one agent trigger tool: `invoke_agent(agentId, prompt, context?, invocationContext)`. The tools `invoke_claude` and `invoke_codex` SHALL NOT be registered. All agent invocations in the workflow SHALL go through `invoke_agent` exclusively.

The coordinator SHALL also expose a second tool: `invoke_reviewer(reviewerId, stage, artifacts, invocationContext)` for dispatching external CLI peer reviewers during review gates. This tool wraps the existing `invoke_agent` subprocess logic but returns structured `ReviewerFindings` instead of `AgentMessage`.

#### Scenario: Agent invoked via `invoke_agent`
- **WHEN** the workflow loop calls `invoke_agent` with a registered `agentId`, a prompt, and an artifact context
- **THEN** the coordinator SHALL apply the agent's specialty prompt, spawn the CLI subprocess, wrap the response as an `AgentMessage`, return it as the MCP tool result, and log the invocation with full call-tree IDs to the audit log

#### Scenario: External reviewer invoked via `invoke_reviewer`
- **WHEN** Claude in the VS Code session calls `invoke_reviewer` with a reviewer ID and stage artifacts
- **THEN** the coordinator SHALL spawn the reviewer's CLI subprocess, pass artifact content as context, and return structured `ReviewerFindings` (array of finding, severity, proposed fix)

#### Scenario: Agent trigger tool times out
- **WHEN** `invoke_agent` is called and the CLI subprocess does not return within the configured timeout
- **THEN** the tool SHALL treat the response as a `block`, log an `agent_error` entry, and the workflow SHALL escalate to a human checkpoint

#### Scenario: Reviewer tool times out
- **WHEN** `invoke_reviewer` is called and the CLI subprocess does not return within the configured timeout
- **THEN** the tool SHALL return an empty findings list with a timeout warning, allowing the gate to proceed with other reviewers

#### Scenario: Removed tool name called
- **WHEN** an MCP client calls `invoke_claude` or `invoke_codex`
- **THEN** the MCP server SHALL return a standard unknown-tool error response

### Requirement: MCP server configuration is externalized
The coordinator MCP server configuration SHALL include the agent registry map, `consensus` policy block, `spawning` guardrail block, and `reviewers` block in `mcp-config.json`. Agent CLI paths, specialties, review/revision/implementation capability flags, sub-invocation permissions, consensus round limits, spawning thresholds, and reviewer definitions SHALL be configurable without source changes.

#### Scenario: Custom agent registry loaded
- **WHEN** the coordinator starts and reads `mcp-config.json`
- **THEN** the MCP server SHALL register `invoke_agent` and validate every agent entry in the registry before accepting any connections

#### Scenario: Reviewers block parsed
- **WHEN** the coordinator starts and reads `mcp-config.json`
- **THEN** entries in the `reviewers` block are validated; entries with `cli` are external CLI reviewers; entries without `cli` are Claude sub-agent definitions

#### Scenario: Spawning config applied
- **WHEN** `mcp-config.json` specifies `spawning.maxDepth: 3`
- **THEN** the coordinator SHALL enforce a depth limit of 3 for all `invoke_agent` calls in that session

#### Scenario: Session state loaded from pre-change run
- **WHEN** the coordinator resumes a session whose `state.json` predates the new spawn-tracking fields
- **THEN** the loader SHALL backfill missing spawn-tracking state with default values before validating and continuing the session

## ADDED Requirements

### Requirement: invoke_reviewer returns structured ReviewerFindings
The `invoke_reviewer` MCP tool SHALL return a structured response containing an array of findings, each with a finding description, severity hint (`critical`, `major`, `minor`), proposed fix, and the file or artifact section the finding applies to.

#### Scenario: ReviewerFindings returned on success
- **WHEN** `invoke_reviewer` completes successfully
- **THEN** the tool result contains `{ findings: Array<{ finding: string, severity: string, proposedFix: string, location: string }> }`

#### Scenario: Empty findings returned when reviewer finds no issues
- **WHEN** the external reviewer CLI returns cleanly with no findings
- **THEN** the tool result contains `{ findings: [] }`
