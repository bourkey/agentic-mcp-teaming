## Context

The `peer-session-bus` change (archived 2026-04-21) added MCP tools for live Claude Code sessions to exchange messages through the coordinator. It did NOT address the coordinator's lifecycle: [src/index.ts](../../../src/index.ts#L205-L241) is built around `start` subcommand that runs phases (`runProposalPhase` → `runDesignPhase` → `runSpecsPhase` → `runTasksPhase` → `ImplementationPhase`), and calls `stopServer()` in the `finally` block. Phases complete, server dies, peer bus dies with it.

The tmux-based opsx workflow needs the opposite shape: the coordinator runs for days across many changes, and individual Claude Code sessions (tmux panes) connect and disconnect freely. This change introduces that operational shape via a `serve` subcommand.

Constraints from the existing codebase:
- Signal handling is already wired via `registerLockCleanupHandlers` from `peer-session-bus`.
- `SessionManager`, `SessionRegistry`, `MessageStore`, `acquireCoordinatorLock`, and `startHttpServer` are all reusable — no new modules needed.
- `mcp-config.json` validation and auth-token wiring already happens in `loadConfig`.

## Goals / Non-Goals

**Goals:**
- A CLI subcommand that starts the coordinator, enables the peer bus, and blocks on signal — nothing more.
- Reuse every existing primitive; no new modules, no new config surface.
- Clear precondition: `serve` requires `peerBus.enabled: true`. Without it, fail fast.
- Clean shutdown: lock file removed, HTTP server closed, session state persisted.

**Non-Goals (this change):**
- systemd/launchd unit files, auto-restart supervisors.
- Health endpoints or status introspection.
- Log rotation or structured JSON logging overhaul.
- Graceful-shutdown drain (wait for in-flight sends to complete before closing).
- Any change to phase-based `start` workflow.
- Any change to peer-bus tool contracts.
- Resuming peer-bus sessions from a phase-driven session (they are separate session-id spaces).

## Decisions

### D1 — `serve` is a distinct subcommand, not a flag on `start`

The existing `start` subcommand runs phases. Adding a `--no-phases` flag would overload it and hide the operational intent. A separate `serve` subcommand makes the two shapes discoverable: "start" = run a phase-driven workflow once; "serve" = host the peer bus indefinitely.

**Alternative considered**: `start --phases=none`. Rejected — flag-overloaded semantics, easy to mis-invoke.

### D2 — Precondition: `peerBus.enabled: true` required

`serve` has no other purpose than hosting the bus. If the config has peer-bus disabled, the subcommand exits with a non-zero status and a clear message. This is fail-fast; the operator is never left guessing why clients can't connect.

### D3 — No agent CLI validation at startup

`start` validates that every declared agent's CLI is in PATH before running workflows. `serve` does NOT run workflows, so it does not need agents and SHALL NOT block on CLI availability. This is important because an operator might run `serve` on a machine where not every agent CLI is installed — the peer bus works regardless.

### D4 — Session shape is shared with phase-driven sessions

`serve` creates a `SessionManager` session just like `start` does (or resumes an existing one via `--session`). The persisted layout under `sessions/<coord-session>/` is identical — `state.json`, `audit.log`, `snapshots/`, plus the peer-bus files (`coordinator.lock`, `registry.json`, `messages.jsonl`). The difference is that `state.json.currentPhase` stays at its initial value because no phase runs.

An operator can later attach a `start` session against the same `sessions-dir` for a specific change — it creates its own session subdirectory, has its own phase state, and does not share the registry or lock file of the `serve` session. If the operator wants both to be live simultaneously, they need to point them at different `sessions-dir` values. This matches the single-instance-lock invariant.

**Alternative considered**: a shared "multi-session" coordinator that runs both modes. Rejected — doubles the lifecycle complexity for a use case nobody has asked for. Keep them separate.

### D5 — Block on signal, not a sleep loop

`serve` calls `startHttpServer`, then `await`s a Promise that resolves only on SIGINT/SIGTERM. No busy loop, no `setInterval` keep-alive. The signal handlers registered by `registerLockCleanupHandlers` take care of releasing the lock; the new `serve` code adds a `stopServer()` call before the process exits, so the HTTP port is freed cleanly.

### D6 — Reuse `peer-session-bus` startup block verbatim

The same bootstrap sequence `start` uses when `peerBus.enabled` is true (mkdir, lock, registry load, store load, reconcile, persist, wire into server) is called from `serve`. Refactoring this into a shared helper keeps both code paths using identical semantics. The helper becomes the single source of truth for "bring the peer bus online."

## Risks / Trade-offs

- **Risk**: operators forget to run `serve` and try to run `start` for the peer bus; coordinator shuts down on phase completion and they're confused why sessions disconnect.
  **Mitigation**: README documents `serve` as the recommended mode when `peerBus.enabled: true`. The `start` path with peer bus enabled still works — it just dies when phases finish, which is valid for short-lived workflows.

- **Risk**: a long-running `serve` session accumulates state indefinitely — `messages.jsonl` grows, `state.json` never advances, `registry.json` accumulates stale sessions.
  **Mitigation**: this is the same tech-debt list from peer-session-bus's Known Limitations (retention, stale-session detection). Operators rotate externally. Proposals to add retention/TTL remain as follow-up work.

- **Risk**: `serve` and `start` both running against the same `sessions-dir` corrupt each other.
  **Mitigation**: the coordinator lock already prevents concurrent coordinators. The second one exits fatally with the first's PID in the error.

- **Trade-off**: no health endpoint. Operators debug via tail-ing `messages.jsonl`, `audit.log`, or using `list_sessions` (… which the bus doesn't have in v1). Accepted; follow-up proposals can add a `whoami` / `list_sessions` tool.

## Migration Plan

Additive. Rollout:

1. Merge this change. Existing `start` workflows unaffected.
2. Operators wanting to run the bus use `serve`. Clients connect as documented in [readme.md](../../../readme.md) "Peer session bus" section.
3. No data migration; no config changes for existing users.

Rollback: operators run `start` instead of `serve`. Or disable peer bus entirely in config.

## Open Questions

None. This is a narrow, additive change. The only structural call (D4 — sessions are separate) is the straightforward one.
