## ADDED Requirements

### Requirement: Spec review gate runs automatically after propose
After `/opsx:propose` completes and artifacts are written, the spec review gate SHALL be triggered automatically in the same Claude session without requiring user intervention.

#### Scenario: Gate triggers on successful propose
- **WHEN** `/opsx:propose` completes and all artifacts are written
- **THEN** the spec review gate starts immediately with the change name and artifact paths as context

#### Scenario: Gate does not trigger on failed propose
- **WHEN** `/opsx:propose` fails before writing artifacts
- **THEN** the spec review gate SHALL NOT be triggered

### Requirement: Spec reviewers run in parallel
All configured spec-stage reviewers (Claude sub-agents and Codex peer) SHALL be dispatched concurrently and their findings collected before synthesis begins.

#### Scenario: Claude sub-agents dispatched in parallel
- **WHEN** the spec review gate starts
- **THEN** all Claude sub-agents with `stage: ["spec", ...]` are launched simultaneously via the Agent tool

#### Scenario: Codex peer reviewer dispatched concurrently
- **WHEN** the spec review gate starts
- **THEN** Codex is invoked via `invoke_reviewer` MCP tool at the same time as Claude sub-agents

#### Scenario: Unavailable optional reviewer is skipped
- **WHEN** an optional reviewer's CLI is not available at invocation time
- **THEN** that reviewer is skipped with a warning logged, and the gate proceeds with remaining reviewers

### Requirement: Spec reviewers assess proposal, design, and spec files
Each spec-stage reviewer SHALL receive the full content of `proposal.md`, `design.md`, and all `specs/**/*.md` files as context for their review.

#### Scenario: Reviewer receives artifact content
- **WHEN** a spec reviewer is dispatched
- **THEN** the reviewer's prompt includes the full text of proposal.md, design.md, and all spec files in the change directory

### Requirement: Spec review gate writes review-gate.lock
After the spec review gate completes, a `review-gate.lock` file SHALL be written to the change directory as a signal that spec review has run.

#### Scenario: Lock file written on gate completion
- **WHEN** the spec review gate finishes (regardless of finding severity)
- **THEN** `openspec/changes/<name>/review-gate.lock` is created with the timestamp and reviewer names

#### Scenario: Apply skill warns on missing lock
- **WHEN** `/opsx:apply` is invoked and `review-gate.lock` is absent
- **THEN** Claude warns the user that spec review has not run, but does not hard-block apply

### Requirement: Spec review gate writes review-summary.md
After each spec review gate run, Claude SHALL write `openspec/changes/<name>/review-summary.md` as an audit artifact.

#### Scenario: Summary created with findings table
- **WHEN** the spec review gate completes
- **THEN** `review-summary.md` is written containing a table with columns: reviewer, severity, finding, fix applied / escalated

#### Scenario: Summary appended on re-run
- **WHEN** the spec review gate runs again on the same change
- **THEN** a new dated section is appended to `review-summary.md` rather than overwriting it
