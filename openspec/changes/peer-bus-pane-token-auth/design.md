## Context

The peer session bus uses a two-layer auth model: a global coordinator auth token (from `mcp-config.json`) and a per-session rotating token issued at `register_session`. The session token is the only credential for `read_messages` and `send_message`, and it lives exclusively in LLM working context. Context compaction or `/clear` destroys it; re-registration is blocked because the coordinator still holds the old entry's token hash and requires a matching `priorSessionToken`. This requires operator intervention (coordinator restart or manual registry edit) to recover.

The current `priorSessionToken` rotation mechanism was designed to prevent session hijacking — only the current holder can reissue their token. But on a single-user local machine, the threat model does not justify the operational cost. The real isolation requirement is: pane A cannot read pane B's messages.

## Goals / Non-Goals

**Goals:**
- Re-registration after compaction/clear always succeeds without operator intervention
- Per-pane isolation is preserved — `claude-main` cannot read `claude-frontend`'s mailbox
- New workflow commands do not need to implement recovery logic; the credential is always available from the environment
- Stale registry entries self-clean via TTL rather than requiring manual removal

**Non-Goals:**
- Multi-user or multi-machine security (this is a local dev tool)
- Removing the rotating `sessionToken` from per-call auth (retained as a lightweight per-call credential; the change is to make it cheaply re-issuable)
- Changing the `send_message` / `read_messages` call signatures beyond removing the `priorSessionToken` concept

## Decisions

### D1: Stable `paneToken` as the durable identity credential

Each pane gets a stable `COORDINATOR_SESSION_TOKEN` injected by the launcher at tmux session start. The coordinator stores `sha256(paneToken)` as `paneTokenHash` on the registry entry — a dedicated field separate from `tokenHash` (the existing rotating per-call credential). `paneTokenHash` is never wiped by `clearTokenHashes()` on restart; `tokenHash` continues to be wiped as today. Re-registration with a matching `paneToken` always succeeds and issues a fresh `sessionToken`.

**Alternative considered**: Keep current model, add coordinator-side TTL only. Rejected: TTL alone leaves a window where an active-but-just-compacted pane is blocked until the TTL expires (minutes of broken state). The env-token approach recovers instantly.

**Alternative considered**: Remove `sessionToken` entirely; use `(name, paneToken)` for all calls. Rejected: `paneToken` would then appear in every tool call and in every turn's hook injection, adding token cost and context noise. Keeping `sessionToken` for per-call auth means the env token is only needed at registration (which is rare).

### D2: `paneToken` validation replaces `priorSessionToken` validation

On `register_session({ name, paneToken })`:
- No existing entry → store `sha256(paneToken)`, issue `sessionToken` (fresh registration)
- Existing entry, `sha256(paneToken)` matches stored hash → issue new `sessionToken` (re-registration, always succeeds)
- Existing entry, no `paneTokenHash` (legacy pre-change entry) → treat as unowned; store `sha256(paneToken)`, issue `sessionToken` (first re-register after upgrade)
- Existing entry, hash mismatch, `lastSeenAt` within TTL → reject with `invalid_pane_token` (name is live and owned by someone else)
- Existing entry, hash mismatch, `lastSeenAt` past TTL → evict old entry, store new hash, issue `sessionToken` (TTL-based takeover for replaced panes)

The `priorSessionToken` parameter and the `invalid_prior_session_token_required` error code are removed entirely. The `paneToken` hash comparison SHALL use `crypto.timingSafeEqual` — never a string equality check — and SHALL be performed even when the result will be ignored (e.g., TTL-eviction path), mirroring the existing `authenticate()` sentinel pattern.

### D3: `paneToken` is required on `register_session`; no anonymous registration

Requiring `paneToken` for all registrations enforces that only launcher-started panes can join the bus. A pane started outside the launcher has no `COORDINATOR_SESSION_TOKEN` and is excluded — matching the existing `$COORDINATOR_SESSION_NAME` unset → silent skip behaviour.

**Alternative considered**: Make `paneToken` optional, allow anonymous registration for backwards compatibility. Rejected: anonymous registration is the source of the current fragility. The launcher already sets `COORDINATOR_SESSION_NAME`; adding `COORDINATOR_SESSION_TOKEN` is a parallel, non-breaking launcher change.

### D4: Inactivity TTL via `peerBus.session.inactivityTtlMs` config field

Default: `600000` (10 minutes). This is the window within which a live session is protected from takeover. `read_messages` updates `lastSeenAt` every turn, so active panes perpetually refresh. A genuinely dead pane (killed, crashed) expires within one TTL window.

The TTL is configurable to allow operators to tune for their workflow cadence. Setting it to `0` means **permanent ownership** — entries are never evicted by inactivity alone, and pane replacement requires coordinator restart or manual registry edit. Operators choosing `0` accept this operational constraint.

### D5: Hook instructs LLM to read `$COORDINATOR_SESSION_TOKEN` from env — raw value is never inlined

The `peer-bus-reminder.sh` hook emits an instruction such as "Use `$COORDINATOR_SESSION_TOKEN` when calling `register_session`". It does NOT include the raw token value in its output. This keeps the token out of conversation history on every turn. The token appears in LLM context only at registration time (once per session start or compaction event) when the LLM reads it from the environment to construct the MCP tool call.

**Alternative considered**: Inline the token in the hook output for simplicity. Rejected: the token would appear in conversation history and logs on every turn.

### D6: Skill recovery collapses to a single rule

After compaction, the skill has no token in context. The recovery is:
1. Call `register_session({ name: $COORDINATOR_SESSION_NAME, paneToken: $COORDINATOR_SESSION_TOKEN })` — the LLM reads the env var when constructing this call
2. Cache the returned `sessionToken` in working context
3. Continue

The entire `priorSessionToken` recovery budget, per-turn limits, `invalid_prior_session_token_required` terminal error, and "operator must remove registry entry" message are removed from the skill.

## Risks / Trade-offs

**`COORDINATOR_SESSION_TOKEN` in tmux environment** → Any process that can run `tmux showenv` can read the token. Acceptable: this is a local dev tool on a single-user machine; the token only grants access to a local MCP server. Mitigation: tokens are generated fresh per launcher invocation.

**`paneTokenHash` persisted to registry.json** → A stolen or leaked `registry.json` exposes `sha256(paneToken)` for registered panes. Mitigation: `registry.json` is written with mode `0o600`; this is an acceptable risk for a local dev tool. `paneTokenHash` values are hashes, not raw tokens.

**TTL-based takeover race** → If a pane is temporarily paused longer than the TTL and another process tries to register the same name, it could succeed. Mitigation: 10-minute default TTL is generous for interactive use.

**`paneToken` appears in LLM context once per registration** → The raw token value is visible in conversation context at registration time (not per-turn). Acceptable for this threat model. The coordinator-side audit log exclusion does not apply to LLM context.

**Launcher change required in consumer projects** → `start-team-session.sh` must be updated in all consumer repos before restarting sessions. Old launchers fail with `invalid_pane_token_missing` until updated.

## Migration Plan

1. Deploy coordinator change with `paneToken` required on `register_session`
2. Update `start-team-session.sh` in all consumer repos before restarting tmux sessions
3. Update `peer-bus-session` SKILL.md files in all consumer repos
4. Update `peer-bus-reminder.sh` hooks in all consumer repos
5. Restart tmux sessions (or start new ones) — old sessions will fail registration cleanly with a clear error until the launcher is updated

Rollback: revert coordinator change; old skills still work against the old coordinator. No data migration needed (registry.json schema gains an optional field; old registries load cleanly as unowned entries).

## Open Questions

- Should `sessionToken` be renamed to something less confusing now that it is no longer the sole auth layer? **Decision: deferred — cosmetic rename, no behaviour change. File a follow-up task if desired.**
