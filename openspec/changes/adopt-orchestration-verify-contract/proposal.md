## Why

The coordinator can mark implementation work approved from agent or human review without executing the
repository's completion gate, and it hardcodes a workflow model that can drift from the supported
OpenSpec interface. Steward now provides a versioned interface and authenticated execution-verification
contract; the engine must adopt them before Steward can drive it autonomously.

## What Changes

- Add the supported `openspec/config.yaml` layout and consume Steward's versioned artifact/lifecycle and
  engine-phase mapping rather than maintaining an independent hardcoded contract.
- Add an engine execution provider that submits a pinned tree plus trusted approved-declaration digest to
  Steward's gate, verifies the authenticated result, and fails closed when the provider or interface is
  unavailable.
- Require an authenticated `pass` before implementation/review integration or archive can land code;
  agent consensus and human approval remain necessary workflow decisions but cannot substitute for
  execution.
- Run certifying commands offline in a containerized or CI isolation provider with hard CPU, process,
  memory, filesystem, output, and network limits. Dependency preparation remains separate and
  non-certifying.
- Treat OpenSpec artifact and reviewer text as untrusted data that cannot force a terminal approval.

## Capabilities

### New Capabilities

- `steward-verification-adapter`: Consume and verify Steward's pinned-tree execution result, bind the
  approved declaration digest, provide confined engine execution, and fail closed at code-landing gates.
- `openspec-interface-adapter`: Load Steward's versioned OpenSpec contract and phase mapping, validate
  conformance, and surface layout/version/phase drift.

### Modified Capabilities

- `task-execution`: Require authenticated executed verification before reviewed task code is integrated
  into the session branch.
- `consensus-workflow`: Preserve review and human checkpoints while prohibiting either outcome from
  bypassing a failed or unverifiable code-landing gate.

## Impact

- Affects coordinator phase orchestration, task integration, archive completion, configuration schemas,
  audit events, tests, OpenSpec layout, and operator documentation.
- Consumes the contract introduced by Steward change `add-orchestration-verify-foundation` and tracked by
  `BourkeyDev/steward#94`.
- This dependent change is tracked by
  [BourkeyDev/steward#109](https://gitea.int.bourkey.dev/BourkeyDev/steward/issues/109) because this
  GitHub-origin repository's Gitea mirror is read-only.
