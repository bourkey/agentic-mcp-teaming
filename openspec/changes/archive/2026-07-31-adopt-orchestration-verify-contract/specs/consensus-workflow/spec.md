## MODIFIED Requirements

### Requirement: Review outcomes distinguish agent consensus from human override

The coordinator SHALL represent two-agent approval and human override as separate artifact outcomes.
Neither outcome SHALL represent executed verification or authorize a code-landing transition without an
authenticated Steward verification `pass`.

#### Scenario: Consensus reached by both agents

- **WHEN** both agents approve the same artifact revision
- **THEN** the coordinator SHALL record `consensus-reached` and, for code-landing work, await the separate
  execution-verification gate

#### Scenario: Workflow advanced by human override

- **WHEN** a human operator elects to continue after a timeout, block, or revision-cap deadlock
- **THEN** the coordinator SHALL record `human-approved`, SHALL NOT relabel it as `consensus-reached`, and
  SHALL NOT bypass a failed, absent, unauthenticated, or unverifiable execution gate
