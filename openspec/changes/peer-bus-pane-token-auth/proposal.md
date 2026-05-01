## Why

Session tokens are issued by the coordinator at registration and stored only in LLM working context — context compaction or `/clear` destroys them, leaving the consumer unable to re-register because the coordinator still holds the old entry. Every workflow command that calls `send_message` inherits this fragility, and every new command added requires the same brittle `priorSessionToken` dependency.

## What Changes

- `register_session` gains a required `paneToken` parameter — registration without it is rejected with `invalid_pane_token_missing`
- The coordinator stores `sha256(paneToken)` as the durable identity credential for a session name; re-registration with a matching `paneToken` always succeeds, replacing the old rotating-token + `priorSessionToken` protocol
- Stale entries (where `paneToken` hash does not match) are evicted automatically after a configurable inactivity TTL, allowing clean takeover when a pane is genuinely replaced
- The peer-bus-session skill is simplified: reads `$COORDINATOR_SESSION_NAME` and `$COORDINATOR_SESSION_TOKEN` from env, calls `register_session({ name, paneToken })` — recovery after compaction is one tool call, no operator intervention
- Workflow commands drop the `priorSessionToken` dependency; they re-register inline if no `sessionToken` is in context, then proceed
- The `peer-bus-reminder.sh` hook injects a reminder to read `$COORDINATOR_SESSION_TOKEN` from env when registering — the raw token value is NOT inlined in hook output
- The tmux launcher generates a unique `COORDINATOR_SESSION_TOKEN` per pane at session start

## Capabilities

### New Capabilities

_(none)_

### Modified Capabilities

- `peer-session-bus`: Authentication model changes — `register_session` now accepts a stable `paneToken` credential; re-registration becomes idempotent for the same pane; rotating `sessionToken` is retained for per-call auth but is now cheaply recoverable via re-registration; inactivity TTL replaces manual registry cleanup

## Impact

- `src/core/session-registry.ts` — registration logic, entry schema, TTL eviction
- `src/server/tools/peer-bus.ts` — `register_session` input schema and handler
- `src/config.ts` — new optional `peerBus.session.inactivityTtlMs` field
- Consumer skill files (`SKILL.md`) across all pane projects — simplified recovery protocol
- `peer-bus-reminder.sh` hook — instruct LLM to read `$COORDINATOR_SESSION_TOKEN` from env (no raw value in output)
- `start-team-session.sh` launcher — generate and inject `COORDINATOR_SESSION_TOKEN` per pane
- Workflow commands (`ship.md`, `worktree.md`, `merge.md`, `sync.md`, `peer-inbox.md`) — replace `priorSessionToken` pattern with inline re-registration guard

## Migration

Deploy coordinator → update `start-team-session.sh` and `peer-bus-session` SKILL.md in all consumer repos → restart tmux sessions. Rollback: revert coordinator; old skills still work. No data migration needed.
