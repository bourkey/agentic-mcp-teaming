## ADDED Requirements

### Requirement: Code review gate runs automatically after apply
After `/opsx:apply` completes all tasks, the code review gate SHALL be triggered automatically in the same Claude session without requiring user intervention.

#### Scenario: Gate triggers on successful apply
- **WHEN** `/opsx:apply` completes all pending tasks
- **THEN** the code review gate starts immediately with the list of modified source files as context

#### Scenario: Gate does not trigger on partial apply
- **WHEN** `/opsx:apply` is paused mid-run (blocked or interrupted)
- **THEN** the code review gate SHALL NOT be triggered until apply fully completes

### Requirement: Code reviewers run in parallel
All configured code-stage reviewers SHALL be dispatched concurrently and their findings collected before synthesis begins.

#### Scenario: Claude sub-agents dispatched in parallel
- **WHEN** the code review gate starts
- **THEN** all Claude sub-agents with `stage: ["code", ...]` are launched simultaneously via the Agent tool

#### Scenario: Codex peer reviewer dispatched concurrently
- **WHEN** the code review gate starts
- **THEN** Codex is invoked via `invoke_reviewer` MCP tool at the same time as Claude sub-agents

### Requirement: Code reviewers assess changed source files
Each code-stage reviewer SHALL receive the content of all source files modified by `/opsx:apply` plus relevant spec and design context.

#### Scenario: Reviewer receives changed file content
- **WHEN** a code reviewer is dispatched
- **THEN** the reviewer's prompt includes the full content of each file changed during apply

#### Scenario: Reviewer receives spec context
- **WHEN** a code reviewer is dispatched
- **THEN** the reviewer's prompt includes the relevant capability spec(s) from `openspec/specs/` for cross-referencing

### Requirement: Agreed code fixes are applied to source files directly
Fixes classified as auto-apply by the synthesis agent SHALL be applied to source files in the working tree immediately after synthesis completes.

#### Scenario: Auto-apply fix modifies source file
- **WHEN** synthesis produces an auto-apply fix for a source file
- **THEN** Claude applies the edit to the file using the Edit tool and logs the change in review-summary.md

#### Scenario: Conflicting fixes are escalated not applied
- **WHEN** two reviewers suggest incompatible edits to the same code section
- **THEN** both suggestions are surfaced to the user rather than either being applied automatically

### Requirement: Code review gate appends to review-summary.md
After the code review gate, Claude SHALL append a `## Code Review` section to the existing `review-summary.md`.

#### Scenario: Code review section appended
- **WHEN** the code review gate completes
- **THEN** a `## Code Review` section is appended to `openspec/changes/<name>/review-summary.md` with a findings table
