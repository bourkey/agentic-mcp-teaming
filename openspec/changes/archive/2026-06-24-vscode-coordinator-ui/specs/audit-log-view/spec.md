## ADDED Requirements

### Requirement: Extension streams audit log entries to a dedicated VS Code Output Channel
The extension SHALL create a VS Code Output Channel named "MCP Coordinator" and write each audit log entry to it in human-readable form as it is received, so the user can see a running log of all coordinator activity without opening the raw NDJSON file.

#### Scenario: Audit log entry written to output channel
- **WHEN** a new audit log entry is received from the active session
- **THEN** the extension SHALL append a formatted, single-line summary to the "MCP Coordinator" output channel within 500ms of the entry being written to disk

#### Scenario: Output channel created on extension activation
- **WHEN** the extension activates
- **THEN** the "MCP Coordinator" output channel SHALL be created and available in the Output panel dropdown, even before a session is active

### Requirement: Audit log entries are formatted for readability
Each audit log entry written to the output channel SHALL be formatted as a human-readable line including: ISO timestamp (truncated to seconds), entry type, and the most relevant fields for that type. Raw JSON SHALL NOT be written verbatim.

#### Scenario: Agent invocation entry formatted
- **WHEN** an `agent_invocation` entry is received
- **THEN** the output channel line SHALL follow the format: `[HH:MM:SS] agent_invocation  <role>  <phase>  artifact=<id>  round=<n>  action=<action>`

#### Scenario: Tool call entry formatted
- **WHEN** a `tool_call` entry is received
- **THEN** the output channel line SHALL follow the format: `[HH:MM:SS] tool_call  <tool>  <params-summary>`

#### Scenario: Phase transition entry formatted
- **WHEN** a `phase_advance` or `phase_complete` entry is received
- **THEN** the output channel line SHALL follow the format: `[HH:MM:SS] phase  <old-phase> → <new-phase>`

#### Scenario: Human decision entry formatted
- **WHEN** a human checkpoint decision entry is received
- **THEN** the output channel line SHALL follow the format: `[HH:MM:SS] checkpoint  <decision>  artifact=<id>`

### Requirement: Output channel supports filtering by entry type
The extension SHALL provide a command "Coordinator: Filter Audit Log" that allows the user to select one or more entry types (agent_invocation, tool_call, phase transitions, human decisions) and limit the output channel to only those types going forward.

#### Scenario: User applies entry type filter
- **WHEN** the user runs "Coordinator: Filter Audit Log" and selects only "agent_invocation"
- **THEN** the output channel SHALL only append new entries of type `agent_invocation`; all other entry types SHALL be silently discarded

#### Scenario: Filter cleared
- **WHEN** the user runs "Coordinator: Filter Audit Log" and selects "Show All"
- **THEN** all entry types SHALL be written to the output channel again
