## ADDED Requirements

### Requirement: Coordinator enforces a registry membership check on every `invoke_agent` call
Before spawning any CLI subprocess, the coordinator SHALL verify that the requested `agentId` exists in the loaded agent registry. Calls referencing unknown agent IDs SHALL be rejected immediately.

#### Scenario: Known agent ID
- **WHEN** `invoke_agent` is called with an `agentId` that exists in the registry
- **THEN** the coordinator SHALL proceed to the remaining guardrail checks

#### Scenario: Unknown agent ID
- **WHEN** `invoke_agent` is called with an `agentId` not present in the registry
- **THEN** the coordinator SHALL return an MCP error, log a `spawn_rejected` audit entry with reason `"unknown-agent"`, and take no further action

### Requirement: Coordinator enforces a maximum call-tree depth
The coordinator SHALL reject any `invoke_agent` call whose computed `depth` exceeds `spawning.maxDepth` (default: 2). A depth-limit violation SHALL also trigger a human checkpoint.

#### Scenario: Invocation within depth limit
- **WHEN** `invoke_agent` is called with `depth` ≤ `spawning.maxDepth`
- **THEN** the coordinator SHALL proceed with the invocation

#### Scenario: Invocation exceeds depth limit
- **WHEN** `invoke_agent` is called with `depth` > `spawning.maxDepth`
- **THEN** the coordinator SHALL reject the call, log a `spawn_rejected` audit entry with reason `"depth-limit-exceeded"` and the current depth, return an MCP error to the calling agent, and escalate to a human checkpoint

### Requirement: Coordinator enforces a maximum concurrent agent invocation count
The coordinator SHALL track the number of agent-initiated `invoke_agent` sub-calls currently in-flight. If accepting a new delegated call would exceed `spawning.maxConcurrentSubInvocations` (default: 5), the delegated call SHALL be rejected. Coordinator-managed first-pass review fan-out SHALL NOT count against this delegated concurrency cap.

#### Scenario: Concurrent cap not reached
- **WHEN** an agent-initiated `invoke_agent` call is made and the number of in-flight delegated invocations is below `spawning.maxConcurrentSubInvocations`
- **THEN** the coordinator SHALL proceed, increment the in-flight counter, and decrement it when the invocation completes

#### Scenario: Concurrent cap reached
- **WHEN** an agent-initiated `invoke_agent` call is made and the in-flight delegated count equals `spawning.maxConcurrentSubInvocations`
- **THEN** the coordinator SHALL reject the call with an MCP error, log a `spawn_rejected` entry with reason `"concurrent-limit-reached"`, and not escalate to a human checkpoint (caller may retry)

#### Scenario: Coordinator review batch exceeds delegated cap
- **WHEN** the coordinator launches a first-pass review round for more agents than `spawning.maxConcurrentSubInvocations`
- **THEN** the coordinator SHALL still invoke all configured reviewers for that round, because the delegated concurrency cap applies only to agent-initiated sub-invocations

### Requirement: Coordinator enforces a per-session invocation budget
The coordinator SHALL maintain a running total of all `invoke_agent` calls in the current session. When the total reaches `spawning.maxSessionInvocations` (default: 50), all further `invoke_agent` calls SHALL be rejected and a human checkpoint SHALL be triggered.

#### Scenario: Budget not exhausted
- **WHEN** `invoke_agent` is called and the session total is below `spawning.maxSessionInvocations`
- **THEN** the coordinator SHALL increment the session total and proceed

#### Scenario: Budget warning threshold reached
- **WHEN** the session total reaches 80% of `spawning.maxSessionInvocations`
- **THEN** the coordinator SHALL log a `spawn_budget_warning` audit entry; workflow continues normally

#### Scenario: Budget exhausted
- **WHEN** `invoke_agent` is called and the session total equals `spawning.maxSessionInvocations`
- **THEN** the coordinator SHALL reject all further invocations, log a `spawn_rejected` entry with reason `"session-budget-exhausted"`, and escalate to a human checkpoint

### Requirement: All spawn rejections are recorded in the audit log
Every rejected `invoke_agent` call SHALL produce a `spawn_rejected` audit entry containing: timestamp, `agentId`, `parentInvocationId`, `depth`, reason code, and the current values of all relevant counters at time of rejection.

#### Scenario: Rejection audit entry written
- **WHEN** any spawning guardrail rejects an `invoke_agent` call
- **THEN** the audit log SHALL contain a `spawn_rejected` entry within 100ms of the rejection, with all required fields populated
