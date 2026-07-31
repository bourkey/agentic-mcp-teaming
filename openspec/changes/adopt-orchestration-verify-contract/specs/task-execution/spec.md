## MODIFIED Requirements

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
