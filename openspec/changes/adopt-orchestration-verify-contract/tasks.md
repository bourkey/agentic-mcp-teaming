## 0. Proposal Tracking

- [x] 0.1 Create and link writable tracking issue `BourkeyDev/steward#109` for the read-only Gitea mirror.

## 1. OpenSpec Interface Adoption

- [ ] 1.1 Add the supported `openspec/config.yaml` layout and record the required Steward interface schema/version.
- [ ] 1.2 Add configuration for the Steward interface and verification executables without hardcoded machine paths.
- [ ] 1.3 Load and validate the interface at startup; fail before agent invocation on missing, malformed, or drifted contracts.
- [ ] 1.4 Replace hardcoded artifact/phase consumers with the validated Steward mapping and update UI/event consumers.

## 2. Trusted Verification Inputs

- [ ] 2.1 Extend session/task state with repository, pinned commit/tree, approved declaration digest, and gate-result identity.
- [ ] 2.2 Accept the approved declaration digest only from the Steward-side driver and reject target-authored or absent approval.
- [ ] 2.3 Bind every verification request and response to the exact candidate tree and declaration digest.

## 3. Engine Execution Provider

- [ ] 3.1 Select and document the existing container/CI runtime that supplies hard memory isolation.
- [ ] 3.2 Materialize immutable pinned provenance plus a disposable writable build copy with scrubbed environment and offline certification.
- [ ] 3.3 Enforce hard wall, CPU, process, memory, filesystem, output, and network limits and attest each active control.
- [ ] 3.4 Keep dependency preparation lockfile-pinned, separate, non-certifying, and unable to access signing material or emit a verdict.
- [ ] 3.5 Return `not-verifiable` without host fallback when the provider or any promised control is unavailable.

## 4. Code-Landing Authorization

- [ ] 4.1 Invoke Steward verification for reviewed implementation candidates and authenticate the returned result.
- [ ] 4.2 Require authenticated `pass` before task-branch integration, implementation/review advancement, or code-landing archive.
- [ ] 4.3 Preserve consensus and human-override outcomes while preventing either from bypassing fail/not-verifiable/unsigned results.
- [ ] 4.4 Re-run review and verification when rebase or conflict resolution changes the candidate tree.

## 5. Audit and Injection Boundary

- [ ] 5.1 Record immutable verification inputs, provider attestation, command outcomes, result digest, and transition decision without secrets.
- [ ] 5.2 Treat all artifact/reviewer text as data and prove injected approval instructions cannot alter conformance or gate outcomes.

## 6. Verification and Delivery

- [ ] 6.1 Add unit tests for interface loading, phase mapping, approved-digest provenance, result authentication, and fail-closed transitions.
- [ ] 6.2 Add integration tests for pass/fail/not-verifiable, stale-tree/declaration rejection, rebase invalidation, and human-override blocking.
- [ ] 6.3 Prove container limits including hard memory and denied egress; prove dependency preparation cannot certify.
- [ ] 6.4 Run `npm test`, `npm run build`, `npm run lint`, and strict OpenSpec validation.
- [ ] 6.5 Update operator and architecture documentation, open the engine PR, link Steward #109/#94, and land only with required checks.
