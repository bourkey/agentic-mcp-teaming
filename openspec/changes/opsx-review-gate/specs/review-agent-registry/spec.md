## ADDED Requirements

### Requirement: Reviewer definitions live in mcp-config.json reviewers block
All reviewer sub-agent roles SHALL be defined in a `reviewers` block in `mcp-config.json`, alongside the existing `agents` block.

#### Scenario: Reviewers block added to config
- **WHEN** `mcp-config.json` is read at gate startup
- **THEN** the `reviewers` object is parsed and each entry is instantiated as either a Claude sub-agent or an external CLI reviewer

#### Scenario: Missing reviewers block treated as empty
- **WHEN** `mcp-config.json` has no `reviewers` block
- **THEN** the gate runs with zero reviewers and logs a warning

### Requirement: Claude sub-agents distinguished from CLI reviewers by absence of cli field
An entry without a `cli` field SHALL be treated as a Claude sub-agent (dispatched via the Agent tool). An entry with a `cli` field SHALL be treated as an external CLI reviewer (dispatched via `invoke_reviewer` MCP tool).

#### Scenario: Claude sub-agent entry dispatched via Agent tool
- **WHEN** a reviewer entry has no `cli` field
- **THEN** Claude dispatches it using the Agent tool with the entry's `role` and `specialty` in the prompt

#### Scenario: CLI reviewer entry dispatched via invoke_reviewer
- **WHEN** a reviewer entry has a `cli` field
- **THEN** Claude calls `invoke_reviewer` on the coordinator MCP server with the entry's `cli`, `role`, and `specialty`

### Requirement: Stage field controls which gate a reviewer runs in
Each reviewer entry SHALL have a `stage` array that lists which gates it participates in (`"spec"`, `"code"`, or both).

#### Scenario: Spec-only reviewer excluded from code gate
- **WHEN** a reviewer entry has `stage: ["spec"]`
- **THEN** that reviewer is dispatched during the spec review gate and NOT during the code review gate

#### Scenario: Reviewer participates in both gates
- **WHEN** a reviewer entry has `stage: ["spec", "code"]`
- **THEN** that reviewer is dispatched in both the spec and code review gates

### Requirement: Optional reviewers are skipped gracefully when unavailable
A reviewer entry with `optional: true` SHALL be skipped with a warning if its CLI cannot be found or fails to start.

#### Scenario: Optional CLI reviewer skipped when not installed
- **WHEN** an optional reviewer's CLI binary is not found on PATH
- **THEN** the gate logs a warning and continues without that reviewer

#### Scenario: Required reviewer failure aborts gate
- **WHEN** a reviewer with `optional: false` fails to start
- **THEN** the gate aborts and reports the error to the user

### Requirement: Reviewer specialty field included in dispatch prompt
Each reviewer entry's `specialty` field SHALL be included verbatim in the prompt sent to that reviewer, scoping what they focus on.

#### Scenario: Specialty scopes reviewer focus
- **WHEN** a reviewer with `specialty: "Security vulnerabilities, threat model gaps"` is dispatched
- **THEN** the dispatch prompt instructs the reviewer to focus specifically on security vulnerabilities and threat model gaps
