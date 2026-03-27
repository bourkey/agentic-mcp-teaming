## ADDED Requirements

### Requirement: Coordinator exposes a single MCP server as the coordination bus
The coordinator SHALL run as an MCP server. All tool access, agent invocations, and workflow control SHALL be performed exclusively through MCP tool calls on this server. No direct agent API calls or separate tool servers are permitted.

#### Scenario: Coordinator MCP server starts successfully
- **WHEN** the coordinator is started with valid configuration
- **THEN** an MCP server SHALL be listening on the configured port and host, binding to loopback by default, and accepting only authorized client connections before any workflow phase begins

#### Scenario: Coordinator MCP server unavailable
- **WHEN** the MCP server fails to bind or crashes during operation
- **THEN** all connected agents SHALL receive an error response and the coordinator SHALL exit with a descriptive error message

### Requirement: Coordinator exposes shared filesystem tools and optional shell execution
The coordinator MCP server SHALL expose at minimum: `read_file`, `write_file`, `grep`, and `glob` tools. The `bash` tool MAY be exposed only when explicitly enabled in configuration. Shared tools are available to authorized MCP clients and proxied to Codex by the coordinator.

#### Scenario: Agent accesses a file via MCP
- **WHEN** Claude calls `read_file` with a path during a workflow phase
- **THEN** the MCP server SHALL return the file contents and record the tool call in the audit log

#### Scenario: Both agents receive equivalent tool output
- **WHEN** both agents are asked to review an artifact referencing specific files
- **THEN** the coordinator SHALL capture the required `read_file`, `grep`, or other shared tool results into a review snapshot and provide that same captured snapshot to both agents for the review round

#### Scenario: Symlink escape is rejected
- **WHEN** a client attempts to read or write a path inside `rootDir` whose real filesystem target resolves outside `rootDir`
- **THEN** the coordinator SHALL reject the tool call with an error and SHALL NOT follow the symlinked path

### Requirement: MCP transport is restricted to trusted clients
The coordinator MCP HTTP transport SHALL bind to `127.0.0.1` by default. If a broader host binding is configured, the coordinator SHALL require an authorization token on MCP transport requests.

#### Scenario: Unauthorized MCP client rejected
- **WHEN** an MCP client connects without the configured authorization token
- **THEN** the coordinator SHALL reject the request with an authorization error before establishing a session or processing tool traffic

### Requirement: Coordinator exposes agent trigger tools
The coordinator MCP server SHALL expose `invoke_claude` and `invoke_codex` tools. These tools accept a prompt and optional context, invoke the respective agent CLI subprocess (`claude -p` / `codex`), and return a structured `AgentMessage`. All agent invocations in the workflow SHALL go through these tools exclusively.

#### Scenario: Agent invoked via MCP tool
- **WHEN** the workflow loop calls `invoke_claude` with a prompt and artifact context
- **THEN** the coordinator SHALL spawn the `claude` CLI subprocess in non-interactive mode, wrap the response as an `AgentMessage`, return it as the MCP tool result, and log the invocation to the audit log

#### Scenario: Agent trigger tool times out
- **WHEN** `invoke_claude` or `invoke_codex` is called and the CLI subprocess does not return within the configured timeout
- **THEN** the tool SHALL return an MCP error response with a descriptive message; the workflow SHALL escalate to a human checkpoint

### Requirement: Coordinator exposes workflow control tools
The coordinator MCP server SHALL expose workflow management tools: `submit_for_consensus`, `advance_phase`, `get_session_state`, and `resolve_checkpoint`. These allow the coordinator loop and human CLI to drive and inspect the workflow via MCP.

#### Scenario: Phase advanced via MCP tool
- **WHEN** `advance_phase` is called after consensus is reached
- **THEN** the coordinator SHALL update the session state, write it to disk, log the transition, and return the new phase name as the tool result

#### Scenario: Human resolves checkpoint via MCP tool
- **WHEN** `resolve_checkpoint` is called with a `proceed` or `abort` decision
- **THEN** the coordinator SHALL record the human decision in the audit log and either advance or halt the workflow accordingly

### Requirement: Codex receives MCP tool results via coordinator injection
Since Codex does not natively speak MCP, the coordinator's `invoke_codex` tool SHALL collect all relevant MCP tool results needed for the current artifact, format them as labeled context blocks, and inject them into the Codex CLI prompt before invoking the Codex CLI subprocess.

#### Scenario: Codex receives injected tool context
- **WHEN** `invoke_codex` is called with an artifact that references project files
- **THEN** the coordinator SHALL load the current review snapshot, prepend the captured tool results to the Codex prompt as labeled context, and only then invoke the Codex CLI subprocess

### Requirement: Review snapshots preserve shared context for a round
For any artifact review that depends on MCP tool output, the coordinator SHALL materialize a review snapshot containing the artifact revision, the shared tool outputs used for review, and a snapshot ID recorded in session state and the audit log.

#### Scenario: Snapshot created before review
- **WHEN** a review round begins for an artifact that references files or search results
- **THEN** the coordinator SHALL execute the necessary shared MCP tool calls once, persist the captured outputs as a review snapshot for that round, and reuse that snapshot for both agents' review prompts

### Requirement: MCP server configuration is externalized
The coordinator MCP server configuration (port, host, tool allowlist, root directory, transport auth settings, and agent CLI command paths) SHALL be defined in `mcp-config.json` and not hardcoded in the coordinator source.

#### Scenario: Custom MCP config loaded
- **WHEN** the coordinator starts and reads `mcp-config.json`
- **THEN** the MCP server SHALL start with the port, host, tool allowlist, root path, transport auth settings, and agent CLI command paths specified in that file

### Requirement: All MCP tool calls are recorded in the audit log
Every MCP tool invocation — shared tools, agent triggers, and workflow tools — SHALL be recorded in the session audit log, including tool name, input parameters, output (truncated if over 2KB), and the phase that triggered the call.

#### Scenario: Tool call logged
- **WHEN** any MCP tool is invoked on the coordinator server
- **THEN** an audit log entry SHALL be appended with: timestamp, tool name, input parameters, output (or truncation marker), and the current workflow phase
