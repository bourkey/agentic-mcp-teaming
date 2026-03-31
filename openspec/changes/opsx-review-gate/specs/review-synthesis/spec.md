## ADDED Requirements

### Requirement: Synthesis agent deduplicates findings across all reviewers
After all reviewer findings are collected, a synthesis agent SHALL produce a unified deduplicated findings list by merging findings that refer to the same issue, regardless of which reviewer raised them.

#### Scenario: Identical findings merged
- **WHEN** two reviewers flag the same issue in the same location
- **THEN** synthesis produces one finding attributed to both reviewers, not two separate findings

#### Scenario: Distinct findings preserved
- **WHEN** two reviewers flag different issues in the same location
- **THEN** synthesis preserves both as separate findings

### Requirement: Synthesis agent classifies severity for each finding
The synthesis agent SHALL classify each deduplicated finding as `critical`, `major`, or `minor` using consistent criteria applied across all reviewers.

#### Scenario: Security vulnerability classified as critical
- **WHEN** a finding describes a security vulnerability, data loss risk, or broken correctness guarantee
- **THEN** synthesis classifies it as `critical`

#### Scenario: Design issue with multiple reviewers agreeing classified as major
- **WHEN** a finding describes a design, interface, or quality issue and 2+ reviewers flagged it
- **THEN** synthesis classifies it as `major`

#### Scenario: Style or minor quality issue classified as minor
- **WHEN** a finding describes a style, naming, or cosmetic issue
- **THEN** synthesis classifies it as `minor`

### Requirement: Synthesis agent proposes a fix for each finding
The synthesis agent SHALL propose a concrete fix for each finding: either a specific edit, a design suggestion, or a question to escalate.

#### Scenario: Fix proposed for auto-apply
- **WHEN** a finding has a clear unambiguous fix
- **THEN** synthesis includes the exact edit (file path, old content, new content) in the structured result

#### Scenario: Escalation proposed for contested finding
- **WHEN** two reviewers propose incompatible fixes for the same finding
- **THEN** synthesis marks the finding as `contested` and includes both suggestions for user review

### Requirement: Synthesis agent detects conflicting fixes
The synthesis agent SHALL identify pairs of fixes that would produce incompatible edits to the same artifact section and mark them as conflicts.

#### Scenario: Conflicting edits detected and escalated
- **WHEN** two reviewer-proposed fixes target overlapping content in the same file
- **THEN** synthesis marks the finding as a conflict pair and escalates to the user

#### Scenario: Non-conflicting edits to same file allowed
- **WHEN** two fixes modify non-overlapping sections of the same file
- **THEN** synthesis treats them as independent and may auto-apply both

### Requirement: Synthesis agent produces a structured SynthesisResult
The synthesis agent SHALL output a structured result containing: deduplicated findings list, conflict pairs, severity classifications, proposed fix per finding, and auto-apply/escalate/drop disposition for each.

#### Scenario: SynthesisResult consumed by orchestrator
- **WHEN** the synthesis agent returns its result
- **THEN** the orchestrating Claude session can iterate the result and apply auto-apply fixes without further LLM calls

#### Scenario: Synthesis agent makes no tool calls
- **WHEN** the synthesis agent runs
- **THEN** it only processes text input and returns structured output; it SHALL NOT call any tools or read files
