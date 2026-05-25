## Spec Review — 2026-04-30

| Reviewer | Severity | Finding | Location | Disposition |
|----------|----------|---------|----------|-------------|
| claude-security | critical | paneToken hash comparison must use timingSafeEqual | design.md D2 / spec register_session | Applied |
| claude-completeness | critical | paneToken must be redacted in all audit log entries | spec register_session | Applied |
| claude-completeness, claude-design | critical | No spec requirement for legacy registry entries (no paneTokenHash) | spec register_session / design D3 | Applied |
| claude-consistency | critical | Proposal bullet 6 implies hook inlines raw token, contradicts design D5 | proposal.md What Changes | Applied |
| claude-security, claude-design | critical | paneTokenHash persistence model unresolved — persist vs wipe on restart | tasks.md 1.5 / spec | **Escalated** |
| claude-completeness | major | Hook output must not inline raw COORDINATOR_SESSION_TOKEN | spec — missing hook section | Applied |
| claude-design, claude-consistency | major | Design D5 "redacted hint" inconsistency / D6 open question contradiction | design.md D5/D6/Open Questions | Applied |
| claude-completeness, claude-security, claude-design | major | TTL=0 + legacy unowned entries undefined; TTL=0 DoS note missing | spec sessionInactivityTtlMs / design D4 | Applied |
| claude-completeness | major | No format/size constraint on paneToken (empty string, DoS) | spec register_session | Applied |
| claude-completeness | major | "startup warn" wrong — eviction happens at registration time | spec eviction scenario | Applied |
| claude-security | major | Eviction warn log has no field restriction; could expose paneToken | spec eviction scenario | Applied |
| claude-design | major | tasks.md 3.1 does not list specific test cases to delete | tasks.md 3.1 | Applied |
| claude-consistency | major | Proposal migration summary omits consumer-repo changes | proposal.md migration | Applied |
| claude-consistency | major | Terminology drift: "cached session token" vs "priorSessionToken" | proposal.md What Changes | Applied |
| claude-completeness | minor | priorSessionToken handling if sent with paneToken | spec register_session | Applied |
| claude-completeness | minor | TTL boundary condition ambiguous (>= vs >) | spec sessionInactivityTtlMs | Applied |
| claude-design | minor | pane_token_required breaks invalid_* convention | spec / tasks.md 2.2 | Applied |
| claude-design | minor | sessionInactivityTtlMs should nest under peerBus.session | proposal Impact / tasks 1.1 / config | Applied |
| claude-consistency | minor | Proposal does not say paneToken is required | proposal.md What Changes | Applied |
| claude-consistency | minor | sessionToken rename open question unacknowledged in spec | design.md Open Questions | Applied |
| claude-security | minor | paneToken in LLM context not acknowledged in spec scenario | spec Fresh registration scenario | Applied |

## Code Review — 2026-04-30

| Reviewer | Severity | Finding | Location | Disposition |
|----------|----------|---------|----------|-------------|
| claude-security | critical | `isAuthorizedRequest` uses `===` for token comparison (timing oracle) | `src/server/index.ts` | Applied |
| claude-security | critical | Case 3 legacy entry can be claimed by any paneToken — design intent vs security risk | `src/core/session-registry.ts` register() | **Escalated** |
| claude-design | critical | `paneToken` minimum entropy: Zod allows single-byte tokens | `src/server/tools/peer-bus.ts` registerSessionTool | Applied |
| claude-security, claude-completeness | major | `PEER_BUS_SESSION_DEFAULT_TTL_MS` duplicated across 3 files — single source required | `src/core/peer-bus-constants.ts` / `session-registry.ts` / `peer-bus.ts` / `config.ts` | Applied |
| claude-security | major | `SESSION_NAME_REGEX` colon removal breaks existing session names | `src/core/peer-bus-constants.ts` SESSION_NAME_REGEX | **Escalated** |
| claude-completeness | major | `persist()` does not chmod after atomic rename — file may be created world-readable | `src/core/session-registry.ts` persist() | Applied |
| claude-design | major | `autoWakeKey in allowlist` prototype-pollution risk | `src/server/tools/peer-bus.ts` registerSessionTool | Applied |
| claude-completeness | major | Audit log null literal for absent autoWakeKey | `src/server/tools/peer-bus.ts` registerSessionTool | Applied |
| claude-design, claude-completeness | major | `restoreEntry()` wipes `wakeStates` unconditionally — debounce window lost on rollback | `src/core/session-registry.ts` restoreEntry() | Applied |
| claude-completeness | major | `load()` does not validate `e.name === key` — registry can be desynchronised | `src/core/session-registry.ts` load() | Applied |
| claude-security | major | Malformed `lastSeenAt` (NaN from `Date.parse`) causes unconditional eviction | `src/core/session-registry.ts` register() | Applied |
| claude-completeness | major | Manual `SESSION_NAME_REGEX.test(name)` duplicates Zod validation after `.regex()` added | `src/server/tools/peer-bus.ts` registerSessionTool | Applied |
| claude-design | major | `persist()` used in test to verify rollback but no test for persist failure rollback path | `tests/peer-bus-tools.test.ts` | Applied |
| claude-completeness | major | `paneTokenHash` persistence round-trip not tested — load() could silently drop the field | `tests/session-registry.test.ts` | Applied |
| claude-completeness | minor | sha256 hex value of paneTokenHash never asserted in tests | `tests/session-registry.test.ts` | Applied |
| claude-completeness | minor | Case 2 unread preservation not covered by any test | `tests/session-registry.test.ts` | Applied |
| claude-design | minor | Truncated/corrupt paneTokenHash in registry.json behaviour untested | `tests/session-registry.test.ts` | Applied |
| claude-design | minor | Comment on `allowedCommands` Object.keys safety missing | `src/server/tools/peer-bus.ts` | Applied |
| claude-design | minor | Comment on outer `register()` catch not explaining why no rollback needed | `src/server/tools/peer-bus.ts` | Applied |
| claude-consistency | minor | `autoWakeKey: null` log entry inconsistency (null literal vs absence marker) | `src/server/tools/peer-bus.ts` | Applied |
| claude-security | drop | Add rate-limiting per paneToken (out of scope for this change) | `src/server/tools/peer-bus.ts` | Dropped |

### Escalation 1 — Case 3 Legacy Entry Hijack

**Finding**: `register()` treats any entry without a `paneTokenHash` (legacy entries from before this change) as "unowned" and allows any caller to claim the session name with a new `paneToken`. The security reviewer flagged this as a session hijack vector during the migration window.

**claude-security suggests**: Reject re-registration against legacy entries and require explicit admin migration or a coordinator restart to clear them.

**claude-design notes**: This is intentional per design decision D3 — legacy entries without `paneTokenHash` are explicitly treated as unowned. The migration path relies on this: the first pane to re-register after upgrade claims the session name. Changing this would break the migration.

**What would you like to do?**
1. Keep D3 as designed — legacy entries are unowned and claimable (current behavior, migration-friendly)
2. Reject re-registration against legacy entries, requiring explicit cleanup before upgrade

---

### Escalation 2 — SESSION_NAME_REGEX Colon Removal

**Finding**: The security reviewer proposed removing `:` from `SESSION_NAME_REGEX` (pattern `^[a-z0-9][a-z0-9:-]{0,62}$`) to tighten the character set. Colons are not valid in DNS hostnames and have potential for namespace confusion.

**claude-security suggests**: Remove `:` from the regex to `^[a-z0-9][a-z0-9-]{0,62}$`.

**Existing consumer names use colons**: Tests and documentation reference sessions named `claude:main`, `opsx:peer-inbox`, etc. Removing colon support would be a breaking change for any deployed sessions using that convention.

**What would you like to do?**
1. Keep colons allowed (current behavior, backwards-compatible)
2. Remove colons — accept the breaking change, require session name migration

---

### Escalation — paneTokenHash Persistence Model

**Finding**: `paneTokenHash` is specified to persist to `registry.json` (task 1.5), but the security reviewers raised a conflict: should `paneTokenHash` survive coordinator restarts (persist) or be wiped like `tokenHash` (no-persist)?

**Option A — Persist** (claude-design recommendation): `paneTokenHash` persists across restarts. Panes can always re-register using their env token after a coordinator restart without any manual intervention. Risk: a stolen `registry.json` exposes `sha256(paneToken)` for all registered panes; mitigated by `0o600` file permissions and the local dev tool threat model.

**Option B — Wipe on load** (claude-security recommendation): `paneTokenHash` is cleared on coordinator restart (like `tokenHash`). After restart, all panes re-register on their first turn — which now works automatically because they have `$COORDINATOR_SESSION_TOKEN` in env. No stolen-registry risk, and restart recovery is still seamless. Slightly less durable but cleaner security posture.

**Resolution: Option A — Persist.** `paneTokenHash` persists across coordinator restarts and is never wiped by `clearTokenHashes()`. Spec and design updated accordingly.
