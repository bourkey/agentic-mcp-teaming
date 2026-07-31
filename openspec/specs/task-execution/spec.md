# Task Execution Specification

## Purpose

Defines how implementation tasks are divided between agents, implemented by their assigned agent, reviewed before acceptance, and integrated through Git using isolated worktrees for concurrent work.

## Requirements

### Requirement: Tasks are divided between agents before implementation begins
After the tasks artifact reaches consensus, the coordinator SHALL present the task list to both agents and produce a task assignment: each task is assigned to a primary implementer (Claude or Codex) and a reviewer (the other agent).

#### Scenario: Task assignment produced
- **WHEN** the tasks artifact is consensus-approved and implementation begins
- **THEN** the coordinator SHALL output a task assignment table mapping each task ID to a primary agent and a reviewing agent, and log this assignment to the audit log

#### Scenario: Both agents approve the task assignment
- **WHEN** the task assignment is presented to both agents for consensus
- **THEN** both agents SHALL respond with `approve` or `request-changes` using the standard consensus loop before any implementation work begins

### Requirement: Each task is implemented by its assigned agent
The coordinator SHALL create an isolated Git branch and worktree for each implementation task, invoke the primary agent with the task description and agreed context, and require the primary agent to return a complete patch plus commit metadata that the coordinator applies inside the task worktree.

#### Scenario: Task implementation submitted
- **WHEN** the primary agent completes a task
- **THEN** it SHALL submit a response containing the task base commit, a complete patch or file change set, a commit message, and a summary of what was done, which the coordinator applies in the task worktree, records, and presents to the reviewing agent

#### Scenario: Agent cannot complete a task
- **WHEN** a primary agent indicates it cannot complete a task (e.g., missing context, out of scope)
- **THEN** the coordinator SHALL escalate to a human checkpoint with the agent's explanation before reassigning or skipping the task

### Requirement: The reviewing agent reviews each implementation before it is accepted
After the primary agent submits an implementation, the coordinator SHALL send the diff and context to the reviewing agent for code review using the standard consensus protocol (`approve` / `request-changes` / `block`).

#### Scenario: Reviewing agent approves implementation
- **WHEN** the reviewing agent responds with `approve` for a task's implementation
- **THEN** the coordinator SHALL mark the task as approved for integration and merge or rebase the reviewed task branch into the session branch

#### Scenario: Reviewing agent requests changes
- **WHEN** the reviewing agent responds with `request-changes` and comments
- **THEN** the coordinator SHALL send the feedback to the primary agent, require a revised full patch, reset the task worktree to the task base or latest approved replay point, apply the revised patch, regenerate the diff, and resubmit it for review; the standard revision cap of 3 rounds applies

### Requirement: Approved task changes are integrated through Git
The coordinator SHALL integrate task changes into the session branch only after the reviewing agent
approves the implementation and Steward's transition authorizer authenticates an execution-verification
`pass` bound to the exact candidate tree and approved declaration digest. The coordinator SHALL use Git
branch/worktree operations rather than direct multi-file writes into the shared working directory.

#### Scenario: Task branch integrated after review and verification
- **WHEN** a task's implementation is approved and its exact candidate tree receives an authenticated
  execution-verification `pass`
- **THEN** the coordinator SHALL integrate the task branch, record the resulting commit SHA and gate
  evidence, and log each changed file path and change type to the audit log

#### Scenario: Review passes but execution does not
- **WHEN** review approves a task but verification fails, is not verifiable, is unauthenticated, or is
  bound to a different tree/declaration
- **THEN** the coordinator SHALL block integration and SHALL NOT treat human override as verification

#### Scenario: Integration conflict or invalidated review
- **WHEN** merge of a reviewed and verified task branch fails because the session branch has moved, or
  the task must be replayed onto a newer session branch head
- **THEN** the coordinator SHALL rebase inside the task worktree, regenerate the diff, and require both
  re-review and re-verification of the new candidate tree before merge; conflicts require human resolution

### Requirement: Concurrent implementation uses isolated worktrees
When the coordinator runs multiple implementation tasks concurrently, each task SHALL be assigned its own Git worktree, and the coordinator SHALL track the base commit and declared file/module scope for each task.

#### Scenario: Concurrent tasks avoid shared checkout mutation
- **WHEN** two approved implementation tasks run at the same time
- **THEN** the coordinator SHALL execute them in separate task worktrees and SHALL NOT allow both agents to write directly into the same checkout
