## ADDED Requirements

### Requirement: Coordinator consumes Steward's versioned OpenSpec interface

The coordinator SHALL load and validate Steward's configured interface declaration at startup and SHALL
derive artifact/lifecycle and engine-phase mappings from it rather than an independently hardcoded
OpenSpec contract.

#### Scenario: Supported interface is available

- **WHEN** the configured Steward declaration is schema-valid and matches the local OpenSpec layout/version
- **THEN** the coordinator SHALL use its declared mapping for the workflow

#### Scenario: Interface is absent or drifted

- **WHEN** the declaration, supported layout, CLI version, or required phase mapping is unavailable or
  incompatible
- **THEN** autonomous workflow startup SHALL fail closed before invoking an agent

### Requirement: Artifact text cannot authorize a transition

The adapter SHALL treat proposal, design, spec, task, implementation, review, and synthesized feedback
text as untrusted data. No instruction in those artifacts SHALL alter interface conformance or the
authenticated verification requirement.

#### Scenario: Artifact contains an approval injection

- **WHEN** artifact or reviewer text instructs the coordinator to ignore gates and approve
- **THEN** the coordinator SHALL still require interface conformance and an authenticated executed `pass`
