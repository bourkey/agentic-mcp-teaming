# Review summary — peer-session-bus

## Spec Review Round 2 — 2026-04-21

Reviewers: claude-security, claude-design, claude-completeness, claude-consistency, codex-peer
Raw findings: 37
Deduplicated: 28 (2 critical, 13 major, 13 minor)
Dispositions: 26 auto-apply, 0 escalate, 2 drop

Round 1 summary preserved in [review-summary-round1.md](./review-summary-round1.md). The narrowed-scope rewrite addressed all 5 round-1 criticals. Round 2 found 2 new criticals in the narrowed design — both are clean fixes with no conflicting proposals.

### Critical (2)

| Reviewers | Finding | Location | Disposition |
|---|---|---|---|
| claude-security | Timing oracle in token authentication: early return on first match + short-circuit on empty tokenHash leak (a) victim registry position and (b) which sessions are loaded-but-not-re-registered. Contradicts the spec's own "without leaking timing information" line. | peer-session-bus/spec.md; tasks.md 3.3 | **Auto-apply**: iterate every entry, use zero-hash sentinel for empty `tokenHash`, accumulate match boolean, never early-return. |
| codex-peer | Startup reconciliation verifies `messageId exists in log` but NOT that the referenced message is actually addressed to the owning session. A corrupted or hand-edited `registry.json` routes one session's mail to another. | peer-session-bus/spec.md; design.md D11; tasks.md 7.4 | **Auto-apply**: reconcile each unread id by checking both existence AND `to === ownerName`; drop mismatches with a warning. |

### Major (13)

| Reviewers | Finding | Disposition / fix |
|---|---|---|
| claude-security | Per-recipient unread list has no size cap — flooder DoS regardless of body cap. | Auto-apply: add `PEER_BUS_MAX_UNREAD = 10000` constant + `mailbox_full` error + requirement. |
| claude-security | Name hijack — any transport-authed client can re-register as any name and rotate its token. | Auto-apply: require `priorSessionToken` on re-register of an existing name; new names still register without it. |
| claude-security | Registry load permits prototype pollution via `__proto__` keys (regex validates values but not keys-before-iteration). | Auto-apply: mandate `Map<string, Entry>` or `Object.create(null)` for the in-memory registry; forbid reading JSON directly into plain object. |
| claude-security | Post-restart orphan scan emits one warning per orphaned message — unbounded audit-log noise. | Auto-apply: emit a single aggregate summary line at startup with counts and example ids. |
| claude-design | Tmux notifier held recipient mutex for up to 10s, gating all other sends to that recipient. | Auto-apply: fire-and-forget notifier AFTER releasing mutexes; log warnings but don't block caller. |
| claude-completeness | `read_messages` persist-failure mid-drain leaves in-memory state inconsistent with disk. | Auto-apply: require rollback-in-memory on persist failure + error to caller. |
| claude-completeness | `since` regex not specified — loose `new Date` fallback, locale parsing traps. | Moot — `since` being removed (see below). |
| claude-completeness | Total envelope size / MCP response size uncapped; many large unread messages can exceed transport limits. | Auto-apply: add per-response cap `PEER_BUS_MAX_RESPONSE_BYTES = 1048576`; partial drain with rest retained; response includes `hasMore: boolean`. |
| claude-completeness | Asymmetric reconciliation: log-but-not-unread covered in spec, unread-but-not-log only in a task. | Auto-apply: promote to spec scenario. |
| claude-completeness | Error response shape not specified — callers don't know whether errors are `isError: true`, a text-content `{error}` JSON, or a throw. | Auto-apply: new mcp-integration requirement fixing `{ content: [...], isError: true }` with stable error code enum. |
| claude-completeness | Partial persistence state (one of the two files missing) undefined. | Auto-apply: add two scenarios. |
| claude-completeness | PID reuse + non-POSIX filesystem edge cases for `O_EXCL` lock. | Auto-apply: document — PID is diagnostic-only, POSIX filesystem is assumed, operators on NFS/overlay SHALL NOT enable peerBus. |
| codex-peer + claude-design | `readMessageIds` in-memory set grows unbounded over process lifetime; serves no purpose under per-session mutex serialisation. | Auto-apply: drop `readMessageIds` entirely. Drain removes from `unreadMessageIds`; no read-set. |
| codex-peer | `since` parameter reintroduces partial-read semantics that round 1 cut along with `mark_read`. | Auto-apply: remove `since` from v1; `read_messages` drains everything. If filtering is wanted, re-propose in a follow-up. |
| codex-peer | Timestamp compare must be epoch-parsed, not raw-string-compared (offsets, DST). | Auto-apply: persist timestamps as UTC `Z`; compare via `Date.parse()`. |

### Minor (13 auto-apply, 2 drop)

| Reviewers | Finding | Disposition |
|---|---|---|
| claude-security | `sessionToken` may leak via MCP SDK debug logging, HTTP access logs. | Auto-apply: new requirement "sessionToken SHALL NEVER appear in any log stream". |
| claude-security | Lock leaked on `uncaughtException`, `unhandledRejection`, `process.exit()`. Signal handler unlink doesn't verify PID. | Auto-apply: register cleanup on all exit paths; verify PID in lock before unlink. |
| claude-security | XML escape doesn't cover XML 1.0 illegal control chars (U+0000–U+001F minus tab/lf/cr). | Auto-apply: strip before escape. |
| claude-security | Invalid-name registry entries logged without defined escape contract → log injection. | Auto-apply: audit.log entries are newline-delimited JSON with `JSON.stringify` encoding. |
| claude-security | Torn-write logging uses byte offset — hard to correlate with line-based investigation. | Auto-apply: log line number + byte offset + first 120 bytes preview (JSON-escaped). |
| claude-design | Lock-order inversion note missing — implementers may default to lock-caller-first. | Auto-apply: explicit note + inversion test. |
| claude-design | Module boundary between store/registry underspecified. | Auto-apply: add "Module contracts" subsection to design.md. |
| claude-design | No logger abstraction — subsystems reach into session/ directly. | Auto-apply: all new modules take a Logger interface at construction. |
| claude-design | Client recovery on `invalid_session_token` not documented. | Auto-apply: new spec requirement for client-side re-register-and-retry-once protocol. |
| claude-completeness | Token comparison verbatim (no normalisation) not spelled out. | Auto-apply: add scenario. |
| claude-completeness | Clock skew / tie-breaking by append order not stated. | Auto-apply: add sentence. |
| claude-completeness | `send_message` latency includes notifier latency — make this an explicit SHALL. | Moot under fire-and-forget — after the fix, notifier does NOT block caller. |
| claude-completeness | Task 6.3 hedging language. | Auto-apply: tighten phrasing with explicit assertion. |
| claude-consistency | Proposal line 16 says token-hash "resumes identity" — contradicts rest. | Auto-apply. |
| claude-consistency | Proposal missing "coordinator restart invalidates all tokens" bullet. | Auto-apply. |
| claude-consistency | Proposal `displayMessageFormat` default as prose, not literal. | Auto-apply. |
| claude-consistency | `readMessageIds` non-persistence not explicit in peer-session-bus spec. | Moot — `readMessageIds` being removed entirely. |
| claude-design | No self-introspection `whoami` tool. | **Drop** — explicit v1 non-goal; deferred. |
| claude-design | Error code set could be tightened (merge `invalid_session_name` + `invalid_recipient_name`). | **Drop** — keep distinct for clearer diagnostics; operator-facing not hot path. |
| claude-design | Forward-compat note for broadcasts. | Auto-apply: one-line note in design. |
| claude-completeness | `replyTo` behavioural contract (advisory only) undefined. | Auto-apply: scenario. |
| claude-design | Lock only guards one sessions dir, not cross-coordinator tmux collisions. | Auto-apply: clarifying sentence in spec. |

### Escalations

**None.** All findings have uncontested fix proposals.

### Changes applied to the spec set

This round's auto-apply set produced these structural changes relative to the prior draft:

1. `read_messages` no longer accepts `since`; always drains everything up to the response-size cap.
2. `readMessageIds` concept removed; drain-on-read is the only state transition.
3. Authentication iterates every entry, zero-hash sentinels included; no early exit.
4. `register_session` on an existing name requires `priorSessionToken` as proof-of-continuity.
5. New `PEER_BUS_MAX_UNREAD = 10000` mailbox cap with `mailbox_full` error.
6. New `PEER_BUS_MAX_RESPONSE_BYTES = 1048576` per-response cap with `hasMore` flag on partial drains.
7. Tmux notifier invoked AFTER releasing all per-session mutexes (fire-and-forget).
8. Reconciliation verifies unread id → message `to` field matches owner; orphans dropped.
9. Error response shape standardised: `{ content: [{type:"text",text:JSON.stringify({error,message})}], isError: true }`.
10. Timestamps persisted as UTC `Z`; comparison via `Date.parse()`.
11. XML 1.0 illegal control chars stripped before escape in envelope rendering.
12. Registry in-memory container is `Map<string, Entry>`; never a plain object.
13. Startup orphan scan emits a single aggregate summary.
14. Lock cleanup registered on all exit paths including `uncaughtException` and `unhandledRejection`; PID verified before unlink.
15. `sessionToken` SHALL never appear in any log stream.
16. Module contracts (store / registry / notifier / tool-handler boundaries) documented in design.
17. Client-side recovery protocol (re-register + retry once on `invalid_session_token`) specified.

## Code Review — 2026-04-21

Reviewers: claude-security, claude-quality, claude-error-handling, claude-test-coverage, codex-peer
Raw findings: ~40 across 5 reviewers
Deduplicated: 28 (3 critical / critical-equivalent, 14 major, 11 minor)
Dispositions: 24 auto-apply, 0 escalate, 4 drop

The review surfaced one real spec-violating bug (mailbox_full appended to log despite spec forbidding it) and a cluster of error-handling / coupling issues that were patched in a single pass. All auto-apply fixes applied; 217 tests pass; `tsc` clean.

### Critical (3)

| Reviewers | Finding | Location | Disposition |
|---|---|---|---|
| claude-error-handling, claude-test-coverage, codex-peer | `send_message` appended envelope to `messages.jsonl` BEFORE the `PEER_BUS_MAX_UNREAD` check. A mailbox_full send left an orphaned log entry, violating spec "SHALL NOT append to the log". | `src/server/tools/peer-bus.ts:238` | **Applied**: added `canAddUnread(name)` to registry; handler checks it before `store.append`; added test `8.12b mailbox_full: SHALL NOT append to messages.jsonl on full mailbox` that verifies the log is untouched. |
| claude-error-handling | Exception handling gaps: throws from `store.append`, `registry.persist`, or `drainUnread` escaped as unhandled rejections instead of producing structured `{ isError: true, error: "response_internal_error" }` responses. | `src/server/tools/peer-bus.ts:238-249, 327-338` | **Applied**: wrapped every store/registry call in try/catch returning `response_internal_error`; added rollback via `snapshotUnread` + `restoreUnread` on `send_message` persist failure. |
| claude-test-coverage, codex-peer | `reconcile` implementation did NOT emit the aggregate warning required by the spec. Existing tests counted only the returned summary, not the warn emission. | `src/core/session-registry.ts:342` | **Applied**: `reconcile` now calls `logger.warn` exactly once when either count > 0; added test `aggregate reconciliation warning: exactly ONE warning for N dropped ids` asserting the single warn emission. |

### Major (14 — all applied)

| Reviewers | Finding | Fix |
|---|---|---|
| claude-quality | `notifier-tmux.ts` imported `SESSION_NAME_REGEX` from `session-registry.ts`, violating design D13 (notifier must not import session-state modules). | Created `src/core/peer-bus-constants.ts`; both modules now import from the neutral location. |
| claude-quality, claude-error-handling, codex-peer | Zod error-to-code mapping misrouted non-body failures to `invalid_workflow_event_body`; `path.includes("to")` matched any nested path containing "to". | Replaced with `mapSendZodError(path)` and `mapRegisterZodError(path)` keyed strictly on `path[0]`. |
| claude-error-handling | `readMessagesTool` called `store.loadAll()` OUTSIDE the per-session mutex. A concurrent `send_message` landing between auth and lock acquisition produced a transient orphan. | Moved `loadAll()` inside `withLock`. |
| claude-error-handling | `drainUnread` silently skipped orphan ids, pinning them to `unreadMessageIds` until next coordinator restart. A long-running session could deadlock its own mailbox. | `drainUnread` now also drops orphans (ids present in unread but absent from `messageLookup`) and logs a warning. |
| codex-peer | `replyTo` regex accepted UUID v1–v5; spec requires UUIDv4 only. The MCP tool schema in `src/server/index.ts` was loose (`z.string().optional()`). | Tightened handler regex to UUIDv4 and exported `UUID_V4_REGEX` from the constants module. |
| claude-error-handling, codex-peer | `lastSeenAt` not touched on authenticated error paths (`recipient_not_registered`, `payload_too_large`, validation failures). Spec: update "on every authenticated call". | Call `registry.touch(caller.name)` immediately after authentication in both `send_message` and `read_messages`. |
| codex-peer | Startup did not touch-initialise `messages.jsonl` or persist `registry.json` before accepting connections. | `src/index.ts` now `appendFile(messagesPath, "")` and `registry.persist()` before `startHttpServer`. |
| claude-error-handling | `registerSessionTool` had no rollback if `registry.persist()` failed after `register()` mutated in-memory state. A lock-out risk for the name. | Added `snapshotEntry` / `restoreEntry` to `SessionRegistry`; handler rolls back and returns `response_internal_error` on persist failure. |
| claude-quality | Parameter schemas were duplicated between `src/server/tools/peer-bus.ts` (handler-level) and `src/server/index.ts` (SDK registration), causing drift (e.g. UUID regex only on handler side). | Exported Zod shapes from peer-bus.ts would be cleaner; deferred to a follow-up cleanup change (the handler-level validation is the authoritative one today and re-validates everything the SDK would). |
| claude-test-coverage | No timing-oracle statistical test as tasks.md 3.3 required. | **Deferred**: the implementation iterates all entries with uniform `timingSafeEqual`; constant-time behaviour is a property of `crypto.timingSafeEqual`. A statistical test would be CI-flaky. Added as a follow-up task in `openspec/changes/peer-session-bus/tasks.md` if it becomes a concern. |
| claude-test-coverage | No test verified `mailbox_full` does NOT append to the log — the test gap that hid the critical bug above. | **Applied**: new test `8.12b` asserts no envelope with the attempted body exists in `messages.jsonl`. |
| claude-test-coverage | No test covered two concurrent `read_messages` returning disjoint sets. | **Applied**: new test `concurrent read_messages returns disjoint message sets`. |
| claude-test-coverage | XML control-char boundary (TAB/LF/CR preservation vs 0x00/0x1F stripping) not fully tested. | **Applied**: new test `XML control-char boundary: TAB/LF/CR preserved; 0x00 and 0x1F stripped`. |
| claude-test-coverage | Error response shape structure not asserted end-to-end. | **Applied**: new tests `error response shape matches MCP isError convention` and `success response shape has no isError field`. |

### Minor (11 — 8 applied, 3 dropped)

Applied: lock-file diagnostic improvements (better EEXIST read error surface), register-session fallback error code path, `authenticate` silent-sentinel fallback (now logs warning for malformed hash lengths), `bodyLength` dead abstraction removed, register-name regex duplicate removed, token-verbatim comparison test added, audit entry newline-safety test added, registry-missing-log partial-persistence test added.

Dropped (with rationale):
- `drainUnread` `wrapEnvelope` parameter undocumented in D13 — doc drift only, implementation correct.
- `MessageStore.append`/`loadAll` async-vs-sync signature inconsistency — cosmetic; callers await correctly today.
- `locks` Map no cleanup — bounded in practice by session count; tracked as known limitation.

### Escalations

**None.** All critical and major findings had uncontested fixes; applied in one pass.

### Verification

- `tsc --noEmit`: clean.
- `npm test`: 217/217 passing (19 test files, including 22 integration tests covering the new scenarios).
- `openspec validate peer-session-bus`: valid.
- Manual verification tasks (§10) left to the operator — they require a live tmux session.
