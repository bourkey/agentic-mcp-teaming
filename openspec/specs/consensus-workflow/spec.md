## ADDED Requirements

### Requirement: Each artifact enters a consensus loop before the workflow advances
The coordinator SHALL not advance to the next workflow phase until both agents have responded with `approve` for the current artifact. An artifact is submitted, each agent reviews it, and the loop repeats until consensus is reached or the revision cap is hit.

#### Scenario: Both agents approve on first round
- **WHEN** both Claude and Codex respond with `approve` for an artifact
- **THEN** the coordinator SHALL mark the artifact as consensus-reached and advance to the next phase

#### Scenario: One agent requests changes
- **WHEN** one agent responds with `request-changes` and provides comments
- **THEN** the originating agent SHALL revise the artifact incorporating the feedback, increment the round counter, and resubmit to both agents for re-review

### Requirement: Initial artifact review is independent per revision
For each artifact revision, the coordinator SHALL collect Claude's and Codex's initial review responses against the same review snapshot before either agent sees the other's feedback.

#### Scenario: First-pass review on the same snapshot
- **WHEN** an artifact revision enters a review round
- **THEN** the coordinator SHALL present the same artifact content and captured tool context to both agents and SHALL NOT include the other agent's review comments until both first-pass responses have been recorded

### Requirement: Consensus revision rounds are capped
The coordinator SHALL enforce a maximum of 3 revision rounds per artifact. If consensus is not reached within 3 rounds, the coordinator SHALL escalate to a human checkpoint.

#### Scenario: Revision cap reached
- **WHEN** the revision round counter for an artifact reaches 3 without both agents approving
- **THEN** the coordinator SHALL pause the workflow, display a summary of outstanding objections to the human operator, and await a human decision before continuing

#### Scenario: Human resolves deadlock
- **WHEN** the human operator provides a decision at an escalated checkpoint
- **THEN** the coordinator SHALL record the human decision in the audit log, mark the artifact as `human-approved`, and advance the workflow with the override noted in session state

### Requirement: An agent may block an artifact with a reason
Either agent MAY respond with `block` to indicate a fundamental objection that cannot be resolved through revision. A `block` SHALL immediately escalate to a human checkpoint regardless of round count.

#### Scenario: Agent blocks an artifact
- **WHEN** an agent responds with `block` and a reason
- **THEN** the coordinator SHALL immediately pause the consensus loop, present the block reason to the human operator, and require explicit human resolution before the workflow can continue

### Requirement: Agents receive prior round context when reviewing
When submitting an artifact for re-review after changes, the coordinator SHALL include all prior rounds' feedback and revisions in the agent prompt so each agent has full context on what was objected to and what changed.

#### Scenario: Revised artifact presented with history
- **WHEN** an artifact is resubmitted after revision
- **THEN** the agent prompt SHALL include: the original artifact, each prior round's feedback from both agents, and the current revised artifact

### Requirement: Review outcomes distinguish agent consensus from human override
The coordinator SHALL represent two-agent approval and human override as separate artifact outcomes.

#### Scenario: Consensus reached by both agents
- **WHEN** both agents approve the same artifact revision
- **THEN** the coordinator SHALL record the artifact outcome as `consensus-reached`

#### Scenario: Workflow advanced by human override
- **WHEN** a human operator elects to continue after a timeout, block, or revision-cap deadlock
- **THEN** the coordinator SHALL record the artifact outcome as `human-approved` and SHALL NOT relabel it as `consensus-reached`

### Requirement: Human checkpoints are presented before phase transitions
Regardless of consensus outcome, the coordinator SHALL pause at a human checkpoint before advancing from one major phase to the next (proposal → design → specs → tasks → implementation), displaying a summary of all agent decisions.

#### Scenario: Pre-phase human checkpoint
- **WHEN** all artifacts in a phase reach a terminal review outcome (`consensus-reached` or `human-approved`) and the workflow is ready to advance
- **THEN** the coordinator SHALL display the consensus summary and wait for explicit human confirmation (e.g., pressing Enter or typing `proceed`) before starting the next phase
