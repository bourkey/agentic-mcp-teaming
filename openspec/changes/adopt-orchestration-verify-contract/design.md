## Context

The coordinator currently owns its six workflow phases in `src/schema.ts`, advances from review outcomes,
and integrates approved task branches without executing the consuming repository's completion gate.
Steward change `add-orchestration-verify-foundation` introduces two external contracts: a versioned
OpenSpec interface and an authenticated three-verdict verification result bound to a pinned tree and
operator-approved declaration blob.

The engine is untrusted with respect to certification: artifact text, reviewer output, implementation
code, and declared verification commands can all be agent-authored. The engine must therefore request
verification but cannot mint its own approved declaration digest, signing key, or terminal verdict.

## Goals / Non-Goals

**Goals:**

- Consume Steward's interface rather than maintaining an independent OpenSpec version clock.
- Block every code-landing integration/archive unless Steward authenticates a `pass`.
- Provide a confined engine execution provider with a hard memory limit unavailable to the macOS
  operator-host provider.
- Preserve consensus and human checkpoints as workflow decisions without treating them as verification.
- Record enough immutable identity and audit evidence to reproduce every gate decision.

**Non-Goals:**

- Absorb the engine repository into Steward.
- Change the number or composition of reviewing agents.
- Give the engine access to Steward's result-signing key or permission to approve declaration changes.
- Add a network-capable certifying step.

## Decisions

### Consume Steward through configured executables and a versioned JSON interface

Add explicit configuration for the installed Steward interface and verification executables. At startup,
the coordinator reads the interface JSON through the configured command, validates its schema/version and
local OpenSpec layout, and derives its phase/artifact mapping from that declaration. Missing executables,
schema mismatch, layout drift, or unsupported phase mapping makes autonomous workflow startup fail closed.

Vendoring the JSON was rejected because it recreates the independent version clock this change removes.
Fetching an interface over the network was rejected because verification must remain operable offline.

### Keep trust inputs outside the target tree and engine

The coordinator requests an approved declaration blob digest from the Steward-side driver for the pinned
target commit. It passes that digest to the gate but never derives approval from the target's own
`steward-verify.json`. A missing or mismatched digest produces `not-verifiable`; declaration evolution is
an operator-approved transition outside the engine.

### Authorize transitions only through authenticated results

For implementation/review integration and archive, the coordinator submits the gate result to Steward's
transition-authorizer. It proceeds only on successful authenticator verification plus verdict `pass`.
`fail`, `not-verifiable`, malformed/unsigned output, provider failure, timeout, and interface drift all
block. Consensus or human override can resolve review disagreement but cannot change this result.

### Use Steward's container provider for engine certification

Steward change `add-container-verification-provider` (#130, implementation commit `e2fc1e6`) supplies the
configured `container-verification-provider` protocol. Steward materializes the pinned tree into a
disposable environment with read-only provenance, a writable build copy, scrubbed environment,
default-deny egress, bounded output, and hard CPU, process, memory, filesystem, and wall-time limits.
The engine supplies immutable request identities and consumes the authenticated result; it does not
materialize, execute, attest, or sign certification itself. V1 has no networked preparation operation:
toolchains and offline dependencies are already present in the approved digest-pinned image or tree.

Reusing the operator's harness sandbox was rejected because it exposes operator capabilities and cannot
apply nested Seatbelt. Running directly on the engine host was rejected because it cannot attest hard
memory isolation on macOS.

### Record verification as immutable audit evidence

Persist the target repository identity, commit/tree, approved and executed declaration digests, provider
attestation, command outcomes, authenticated result digest, and transition decision. Raw secrets and
signing material are never logged.

## Risks / Trade-offs

- **Steward CLI availability becomes a hard dependency** → Validate at startup and fail before agents run.
- **Containerized verification adds latency** → Correctness takes precedence; caching by authenticated
  tree/declaration identity can be added later.
- **Dependency preparation could influence certification inputs** → Require lockfile-pinned inputs and
  record their immutable identity; keep the preparing step unable to emit or sign a verdict.
- **Phase mapping changes can break UI assumptions** → Treat mapping drift as a schema migration and add
  coordinator plus extension regression coverage.

## Migration Plan

1. Add `openspec/config.yaml` and interface configuration without enabling autonomous execution.
2. Implement conformance loading and replace hardcoded phase/artifact consumers.
3. Add the confined provider and authenticated transition authorization behind a fail-closed feature flag.
4. Run existing workflow tests plus pass/fail/not-verifiable, injection, drift, and resource controls.
5. Enable the gate by default only after Steward #94 lands and the installed contract matches.

Rollback disables autonomous code landing and restores no agent-review-only bypass; an unavailable gate
leaves work pending for operator handling.

## Open Questions

None for provider selection. The configured Steward-side driver remains the source of approved declaration
digests; the engine accepts that value only through the named trusted configuration channel.
