# Steward Verification Adapter Specification

## Purpose

Defines how the coordinator binds code-landing transitions to Steward's authenticated, hard-isolated
execution result without acquiring approval or signing authority.

## Requirements

### Requirement: Code-landing transitions require an authenticated executed pass

The coordinator SHALL require Steward's transition authorizer to authenticate an execution-verification
result with verdict `pass` before integrating implementation/review code or completing an archive that
lands code. Agent consensus and human approval SHALL NOT substitute for this gate.

#### Scenario: Reviewed implementation passes execution

- **WHEN** implementation is approved and Steward authenticates a `pass` bound to the exact pinned tree
- **THEN** the coordinator may integrate the code and SHALL audit the verified identity

#### Scenario: Approval accompanies a non-passing result

- **WHEN** an agent or human approves code but verification returns `fail` or `not-verifiable`
- **THEN** the coordinator SHALL block integration and retain the approval only as review evidence

### Requirement: Approved declaration identity comes from the trusted Steward-side driver

The coordinator SHALL pass the target commit and a caller-supplied operator-approved declaration blob
digest to the gate. It MUST NOT infer approval from the target tree or accept a target-authored approved
digest.

#### Scenario: Target changes its declaration

- **WHEN** the pinned tree's declaration blob differs from the Steward-side approved digest
- **THEN** the coordinator SHALL receive `not-verifiable` and require an out-of-band operator transition

### Requirement: Engine verification runs under an attested hard-resource provider

The engine provider SHALL run the certifying step offline with scrubbed environment, immutable pinned
provenance, disposable writes, bounded output, and hard wall, CPU, process, memory, and filesystem limits.
It SHALL fail closed when any promised control cannot be attested.

#### Scenario: Memory or network boundary is unavailable

- **WHEN** the provider cannot prove a hard memory ceiling or default-deny egress
- **THEN** it SHALL return `not-verifiable` and execute no certifying fallback on the host

### Requirement: Verification evidence is auditable without secrets

The coordinator SHALL record repository/commit/tree identity, approved and executed declaration digests,
provider attestation, command outcomes, authenticated result digest, and transition decision without
recording credentials or signing-key material.

#### Scenario: Operator investigates a blocked transition

- **WHEN** verification blocks code landing
- **THEN** the audit log SHALL identify the immutable inputs, verdict, reason, and provider evidence needed
  to reproduce the decision without exposing a secret
