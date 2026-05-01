## 1. Coordinator — Config & Registry

- [x] 1.1 Add `session.inactivityTtlMs` optional field to `peerBus` Zod schema in `src/config.ts` under a `peerBus.session` sub-object (default `600000`, allow `0` to disable)
- [x] 1.2 Add `paneTokenHash?: string` field to `SessionRegistryEntry` in `src/core/session-registry.ts` (separate from existing `tokenHash`; never wiped by `clearTokenHashes()`)
- [x] 1.3 Remove `priorSessionToken` parameter and `invalid_prior_session_token_required` error from `register()` in `src/core/session-registry.ts`
- [x] 1.4 Implement `register(name, paneToken)` logic: fresh registration; hash-match re-registration; legacy unowned (no paneTokenHash) → fresh semantics; hash-mismatch within TTL → reject; hash-mismatch past TTL → evict. Hash comparison MUST use `crypto.timingSafeEqual` — never string equality. Eviction warn log MUST contain only session name and timestamp (no paneToken, no paneTokenHash).
- [x] 1.5 Update `registry.json` serialisation/deserialisation to include `paneTokenHash`; entries without `paneTokenHash` load cleanly as unowned (case 3 in register logic)

## 2. Coordinator — Tool Handler

- [x] 2.1 Update `register_session` input schema in `src/server/tools/peer-bus.ts` to require `paneToken` (string, 1–512 bytes) and remove `priorSessionToken`; strip unknown fields via Zod
- [x] 2.2 Update `registerSessionTool` handler to pass `paneToken` to registry and return `invalid_pane_token` (hash mismatch, live) / `invalid_pane_token_missing` (absent, empty, or oversized) error codes; redact `paneToken` as `"<redacted>"` in all audit log entries
- [x] 2.3 Remove all `priorSessionToken` / `invalid_prior_session_token_required` references from `peer-bus.ts`

## 3. Coordinator — Tests

- [x] 3.1 Update existing `registerSessionTool` tests: replace `priorSessionToken` fixture with `paneToken`; delete these now-invalid cases: `"rejects priorSessionToken on fresh registration"`, `"accepts re-registration without priorSessionToken on empty-tokenHash entry"`, `"rejects re-registration without priorSessionToken on active name"`. Update expected error codes to `invalid_pane_token` / `invalid_pane_token_missing`.
- [x] 3.2 Add test: re-registration with matching `paneToken` always succeeds and issues new `sessionToken`
- [x] 3.3 Add test: registration without `paneToken` (and empty string, oversized) returns `invalid_pane_token_missing`
- [x] 3.4 Add test: mismatched `paneToken` within TTL returns `invalid_pane_token`
- [x] 3.5 Add test: mismatched `paneToken` past TTL evicts entry and succeeds
- [x] 3.6 Add test: `peerBus.session.inactivityTtlMs: 0` — hash mismatch always rejected; legacy unowned entry still allows fresh registration
- [x] 3.7 Add test: legacy entry (no `paneTokenHash`) allows fresh registration regardless of TTL setting
- [x] 3.8 Add test: eviction warn log contains only session name and timestamp (no paneToken or paneTokenHash in warn fields)
- [x] 3.9 Run `npm test` — all 296+ tests pass

## 4. Consumer — Launcher

- [x] 4.1 Update `start-team-session.sh` in `sysdig-pov-docs` to generate a unique `COORDINATOR_SESSION_TOKEN` per pane (e.g. `openssl rand -base64 32`) and inject alongside `COORDINATOR_SESSION_NAME`

## 5. Consumer — Hook

- [x] 5.1 Update `peer-bus-reminder.sh` in `sysdig-pov-docs` to instruct the LLM to read `$COORDINATOR_SESSION_TOKEN` from env when calling `register_session`; the raw token value MUST NOT appear in hook output

## 6. Consumer — Skill Files

- [x] 6.1 Update `peer-bus-session` SKILL.md in `sysdig-pov-docs`: replace `register_session({ name })` with `register_session({ name, paneToken: $COORDINATOR_SESSION_TOKEN })`
- [x] 6.2 Remove `priorSessionToken` rotation, `invalid_prior_session_token_required` terminal error, and "operator must remove registry entry" message from SKILL.md
- [x] 6.3 Simplify recovery protocol to: if no `sessionToken` in context, call `register_session({ name, paneToken })` → cache new token → continue
- [x] 6.4 Replicate SKILL.md changes to `sysdig-pov-docs-frontend`, `sysdig-pov-docs-backend`, `sysdig-pov-docs-misc`

## 7. Consumer — Workflow Commands

- [x] 7.1 Update `peer-inbox.md`: replace `priorSessionToken` recovery path with inline re-registration guard using `paneToken`
- [x] 7.2 Update `ship.md`, `worktree.md`, `merge.md`, `sync.md`: replace `<cached session token>` references with "if no `sessionToken` in context, call `register_session({ name: $COORDINATOR_SESSION_NAME, paneToken: $COORDINATOR_SESSION_TOKEN })` first"
- [x] 7.3 Verify no remaining `priorSessionToken` or `invalid_prior_session_token_required` references in any command file

## 8. Validation

- [ ] 8.1 Start a new tmux session via launcher; confirm `COORDINATOR_SESSION_TOKEN` is set in each pane env
- [ ] 8.2 Run a consumer turn; confirm `register_session` succeeds with `paneToken`
- [ ] 8.3 Simulate compaction (use `/clear` in the consumer pane); run another turn; confirm re-registration succeeds without operator intervention
- [ ] 8.4 Confirm a pane with wrong/no `COORDINATOR_SESSION_TOKEN` is rejected (`invalid_pane_token` / `invalid_pane_token_missing`)
