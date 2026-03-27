## ADDED Requirements

### Requirement: Extension discovers coordinator configuration from workspace
The extension SHALL read `mcp-config.json` from the VS Code workspace root to determine the coordinator's host, port, and root directory. For v1, the extension SHALL assume the session directory is `sessions/` under the workspace root unless a future coordinator/config change exposes a different path. If `mcp-config.json` is absent, the extension SHALL display a status bar warning and enter a disconnected state.

#### Scenario: Config found at workspace root
- **WHEN** the extension activates and `mcp-config.json` exists in the workspace root
- **THEN** the extension SHALL parse the file, extract `host`, `port`, and `rootDir`, and use them for all subsequent coordinator connections

#### Scenario: Default sessions directory inferred
- **WHEN** the extension activates and the workspace contains a `sessions/` directory
- **THEN** the extension SHALL use that directory for session discovery and audit log tailing

#### Scenario: Sessions directory missing
- **WHEN** the extension activates, `mcp-config.json` exists, and no `sessions/` directory is present under the workspace root
- **THEN** the extension SHALL show a status bar item with text "Coordinator: no sessions dir" and remain disconnected from session data

#### Scenario: Config missing
- **WHEN** the extension activates and `mcp-config.json` does not exist in the workspace root
- **THEN** the extension SHALL show a status bar item with text "Coordinator: no config" and take no further connection action

### Requirement: Extension tracks the active session directory
The extension SHALL watch the inferred v1 sessions directory (`<workspaceRoot>/sessions`) for new or modified subdirectories and automatically select the most recently modified session as the active session. The user MAY override the active session via a command palette command.

#### Scenario: New session detected
- **WHEN** a new `sessions/<id>/` directory appears while the extension is active
- **THEN** the extension SHALL switch the active session to the new session ID and begin tailing its audit log

#### Scenario: No sessions exist
- **WHEN** the extension activates and the sessions directory is empty or absent
- **THEN** the extension SHALL display "Coordinator: no active session" in the status bar and wait

#### Scenario: User switches session via command palette
- **WHEN** the user runs "Coordinator: Switch Session" and selects a session ID from the quick-pick list
- **THEN** the extension SHALL stop tailing the previous audit log and start tailing the selected session's audit log

### Requirement: Extension tails the session audit log for live events
The extension SHALL monitor `sessions/<id>/audit.log` using filesystem watch events and read new NDJSON entries as they are appended. Each entry SHALL be parsed and translated into extension events before dispatch to the appropriate view (conversation, phase status, audit output channel).

#### Scenario: New audit log entry appended
- **WHEN** a new line is appended to the active session's `audit.log`
- **THEN** the extension SHALL read and parse the new NDJSON entry within 500ms and dispatch it to all registered event handlers

#### Scenario: Audit log does not yet exist
- **WHEN** the active session directory exists but `audit.log` has not been created yet
- **THEN** the extension SHALL watch for file creation and begin tailing once the file appears

#### Scenario: Malformed NDJSON line
- **WHEN** a line in the audit log cannot be parsed as JSON
- **THEN** the extension SHALL log a warning to its own output channel and continue processing subsequent lines without interruption

#### Scenario: Audit entry translated to extension event
- **WHEN** the tailer reads an audit entry of type `phase_advance`
- **THEN** the extension SHALL publish a `phase_changed` event carrying the old and new phase values

### Requirement: Extension maintains a persistent MCP SSE connection for write operations
The extension SHALL establish and maintain one SSE connection to the coordinator's `/sse` endpoint in order to obtain a valid MCP session ID. This session ID SHALL be used for all subsequent `POST /message` tool calls (e.g. `resolve_checkpoint`).

#### Scenario: SSE connection established
- **WHEN** the coordinator is reachable at the configured host and port
- **THEN** the extension SHALL connect to `/sse`, receive a session ID, and hold the connection open

#### Scenario: Coordinator not yet running
- **WHEN** the SSE connection attempt fails because the coordinator is not listening
- **THEN** the extension SHALL retry with exponential backoff (max 30 seconds) and update the status bar to "Coordinator: connecting…"

#### Scenario: SSE connection dropped mid-session
- **WHEN** an established SSE connection is interrupted
- **THEN** the extension SHALL attempt to reconnect and update the status bar to "Coordinator: reconnecting…"
