## ADDED Requirements

### Requirement: Consensus loop operates over an array of configured agents
The consensus loop SHALL accept a list of reviewer agent IDs from the registry rather than two hardcoded roles. All reviewer agents SHALL be invoked concurrently for the first-pass review of each round. The loop SHALL require unanimous approval to reach consensus.

#### Scenario: All agents approve
- **WHEN** all agents in the reviewer list return `action: "approve"` for the same artifact revision
- **THEN** the consensus loop SHALL record `consensus-reached` and advance the workflow

#### Scenario: Parallel first-pass invocation
- **WHEN** a review round begins
- **THEN** the coordinator SHALL invoke all reviewer agents concurrently and collect all responses before evaluating consensus or sharing any agent's feedback

#### Scenario: One agent requests changes
- **WHEN** one or more agents return `action: "request-changes"` and none return `action: "block"`
- **THEN** the consensus loop SHALL aggregate all change-request content into a unified revision prompt and pass it to the authoring agent for revision; the round count SHALL increment

#### Scenario: Any agent blocks
- **WHEN** any agent returns `action: "block"`
- **THEN** the consensus loop SHALL immediately escalate to a human checkpoint regardless of how many other agents approved; no majority override is permitted

#### Scenario: Revision cap reached
- **WHEN** the round count reaches `consensus.maxRounds` without all agents approving
- **THEN** the consensus loop SHALL escalate to a human checkpoint with a summary of outstanding objections

### Requirement: Multi-agent feedback is aggregated into a single revision request
When one or more agents request changes, the coordinator SHALL merge all agents' `content` fields into a single structured document, grouped by agent ID, before passing the revision request to a configured revising agent (`canRevise: true`).

#### Scenario: Feedback from multiple agents merged
- **WHEN** two or more agents return `action: "request-changes"` in the same round
- **THEN** the revision prompt SHALL contain a `## Revision Requested — Round <n>` header followed by one `### From: <agentId>` section per requesting agent, each containing that agent's full `content` body

#### Scenario: Revision target selected from revising agents
- **WHEN** a round requires revision
- **THEN** the coordinator SHALL route the aggregated revision request only to an agent configured with `canRevise: true`

#### Scenario: Feedback truncated per agent
- **WHEN** an individual agent's `content` exceeds the configured per-agent feedback limit (default: 2048 characters)
- **THEN** the coordinator SHALL truncate the content at the limit and append a `[truncated]` marker before including it in the aggregated revision prompt

### Requirement: Consensus evaluator handles partial CLI failures as blocks
If a reviewer agent's CLI subprocess exits with an error or times out, the coordinator SHALL treat that agent's response as `action: "block"` for consensus evaluation purposes, triggering the human checkpoint path.

#### Scenario: Agent CLI error during review
- **WHEN** an `invoke_agent` call for a reviewer agent fails due to a CLI error or timeout
- **THEN** the coordinator SHALL log an `agent_error` audit entry, treat the failed agent as having blocked, and escalate to a human checkpoint
