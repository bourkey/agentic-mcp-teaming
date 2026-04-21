# Review summary — peer-session-bus

## Spec Review — 2026-04-21

Reviewers: claude-security, claude-design, claude-completeness, claude-consistency, codex-peer
Raw findings: 62 across 5 reviewers
Deduplicated: 42 (5 critical, 17 major, 20 minor)
Dispositions: 35 auto-apply, 3 escalate, 4 drop

### Critical (5)

| Reviewers | Finding | Location | Disposition |
|---|---|---|---|
| security, design, completeness, codex | Caller identity spoofable: no binding between MCP transport and registered session — any client can impersonate, drain mailboxes by re-registering, or inject `from="unknown"`. Persistence allows cross-restart impersonation. | peer-session-bus/spec.md, design.md, tasks.md 5.9 | Auto-apply: bind identity to transport via register_session-issued capability token (timingSafeEqual); require re-registration after reconnect; reject unbound writes. |
| security, completeness | No body-size limit on send_message; unbounded pending queues; default retention unlimited — DoS / OOM vector. | peer-session-bus/spec.md | Auto-apply: add `peerBus.limits.maxBodyBytes` (default 65536 chat, 262144 workflow-event), pending-queue cap (1000/name default), per-sender rate limit, total-bytes cap. |
| design, codex | Retention resurrects read messages on restart (prunes receipts but reconciliation treats receipt-less messages as unread). | peer-session-bus/spec.md, design.md | Auto-apply: per-session retention watermark/cutoff surviving receipt pruning (or drop retention this round). |
| design, codex | Broadcast delivery not durably reconstructable across restart; also a registration race loses the broadcast. | peer-session-bus/spec.md, design.md | **Escalate** — two incompatible fix options (materialise per-recipient records at send vs. compute recipients dynamically at read). |
| security | tmux `display-message` interprets `#(…)` format sequences — attacker-controlled `{from}` can execute arbitrary shell even via `execFile` (format expansion, not shell injection). | peer-notifier/spec.md | Auto-apply: strip `#`/backtick/`$`/`;`/`&`/`|`/newline from substituted values and from `displayMessageFormat` at config-load. |

### Major (17)

| Reviewers | Finding | Location | Disposition |
|---|---|---|---|
| design, consistency, codex | Tool-count drift: proposal says 4 tools (missing `mark_read`); design allowlist omits `mark_read`; peer-session-bus scenario says "all four". | proposal.md, design.md, peer-session-bus/spec.md | Auto-apply: normalise to five everywhere; add Decisions subsection on ack model. |
| design, codex | `register_session` identity contract inconsistent — design says name derived from env var coordinator "cannot" read; specs require `name`. | design.md, peer-session-bus/spec.md, mcp-integration/spec.md | Auto-apply: make `name` required; move env-var derivation to launcher docs. |
| design, completeness | Envelope conflates on-disk JSON and on-read XML wrapper; read_messages content type contradictory. | peer-session-bus/spec.md, mcp-integration/spec.md, design.md | Auto-apply: store layer emits `PeerMessage` records only; tool handler renders `<peer-message>` once; define concrete `PeerMessage` type. |
| security | Envelope breakable: body containing `</peer-message>` escapes boundary; attribute values unescaped. | peer-session-bus/spec.md | Auto-apply: XML-escape body + attributes, or wrap body in CDATA. |
| consistency | Envelope attribute drift: proposal has two (`from`, `kind`); design/spec have three including `messageId`. | proposal.md | Auto-apply: add `messageId` attribute to proposal example. |
| security, completeness | Session-name regex applied unevenly: `send_message.to`, pending keys, registry-load bypass it; `to` accepts empty/whitespace/shell chars. | peer-session-bus/spec.md | Auto-apply: validate at every ingress; `to` must match regex OR equal `"all"`. |
| security | Multi-instance coordinator corrupts JSONL / overwrites registry.json with no file locking. | design.md, peer-session-bus/spec.md | Auto-apply: `flock` on `sessions/<id>/coordinator.lock`; fatal if held. |
| completeness | Concurrency within a single session unspecified (two parallel read_messages race mark_read; concurrent register_session silently overwrites). | peer-session-bus/spec.md | Auto-apply: per-session async mutex; concurrent-register scenario; optional freshness-window refusal. |
| security | `worktreePath`, `role`, `replyTo` stored unvalidated — shape injection / envelope escape via stored fields. | agent-registry/spec.md, peer-session-bus/spec.md | Auto-apply: validate shape/length/charset at Zod boundary; require replyTo to match UUIDv4 regex. |
| design, consistency, codex | Notifier interface multiplexes delivery/clear through one method; signature drifts; `mark_read→0` path not wired. | peer-notifier/spec.md, design.md, tasks.md 5.7 | Auto-apply: split into `onMessageDelivered`/`onMailboxCleared`; align signature; add notifier-reset task. |
| design | Pull-only dismissal of long-poll does not acknowledge idle-peer problem (nothing wakes an idle pane). | design.md | Auto-apply: add "Known limitations — idle sessions do not process messages." |
| design, completeness | Error paths for unregistered callers under-specified; spec allows `from="unknown"` contradicting task 5.9. | peer-session-bus/spec.md | Auto-apply: add scenarios (unregistered caller → error with code `session_not_registered`, no lastSeenAt update). |
| completeness | `mark_read` undefined when ids exist but are not in caller's mailbox — lets one session manipulate another's read state. | peer-session-bus/spec.md | Auto-apply: scenario — treat not-mine as unknown; do not mutate another session. |
| completeness | No `deregister_session` / TTL; stale sessions accumulate forever; notifier fires at dead targets. | peer-session-bus/spec.md, agent-registry/spec.md, tasks.md | Auto-apply: add `deregister_session` tool + `peerBus.liveness.staleAfterSeconds` (default 3600) marking stale; optional auto-prune. |
| completeness | Pending queue for never-registering name grows unbounded. | peer-session-bus/spec.md | Auto-apply: `peerBus.retention.pendingTTLSeconds` (default 86400) or per-name length cap. |
| completeness | `workflowEvent` body has no contract — defeats distinct kind. | peer-session-bus/spec.md, proposal.md | **Escalate** — schema-free with defensive-parse vs. minimal `{ event: string, …rest }` envelope with named initial events. |
| completeness | Transport rebinding after register_session unaddressed — reconnects silently misdirect. | design.md, peer-session-bus/spec.md | Auto-apply: scenario — disconnect+reconnect → new transport unbound; client re-registers. |
| consistency | Pending delivery-trigger drift (spec: first `read_messages` after register; tasks: first `register_session` or `read_messages`). | peer-session-bus/spec.md, tasks.md | Auto-apply: promote on register; return on next `read_messages`. |

### Minor (20)

| Reviewers | Finding | Location | Disposition |
|---|---|---|---|
| security | Loose `since` parsing (`Date` fallbacks, NaN compares). | peer-session-bus/spec.md | Auto-apply: strict ISO-8601 regex at Zod boundary. |
| security, design | Audit-log truncation length & field rule unspecified. | mcp-integration/spec.md | Auto-apply: send_message audit stores `{to, kind, replyTo, messageId, bodyHash, bodyLength}` — never raw body; read_messages audit stores `{count, firstId, lastId}`. |
| security | `messageId` origin/uniqueness unspecified — caller-supplied could collide. | peer-session-bus/spec.md | Auto-apply: coordinator-generated only; any caller-supplied value ignored; duplicates on reconcile warn. |
| security, design | `persistence.messagesFile`/`registryFile` are false-flexibility configurable paths. | mcp-integration/spec.md, design.md | Auto-apply: drop from config, hardcode filenames. |
| design | Hardcoded emoji in default `displayMessageFormat`; substitution rules for `{…}` unspecified. | peer-notifier/spec.md | Auto-apply: move default to module constant; enumerate valid tokens; spec behaviour for unknown token. |
| completeness | Order guarantees for `read_messages` unspecified. | peer-session-bus/spec.md | Auto-apply: ascending timestamp order; scenario. |
| completeness | Tasks 2.2, 5.9, 9.x lack verifiable acceptance. | tasks.md | Auto-apply: tighten phrasing with concrete assertions. |
| consistency | MCP tool result format not tied to existing `{content:[{type:'text',text:...}]}` convention. | mcp-integration/spec.md | Auto-apply: add sentence that documented shapes are JSON-serialised into MCP text content. |
| consistency | design.md schema example missing `.strict()` chain. | design.md | Auto-apply: chain `.strict()` or add note. |
| consistency | Proposal says "registry snapshots" (colliding with existing `snapshots/`). | proposal.md | Auto-apply: "registry state". |
| consistency | Task 1.3 prescribes "commented-out peerBus example" in JSON — illegal. | tasks.md | Auto-apply: reword to docs-only example or `enabled:false` concrete example. |
| consistency | agent-registry describes `unreadMessageIds` as "pending" — clashes with distinct pending-for-unregistered concept. | agent-registry/spec.md | Auto-apply: say "unread". |
| consistency | Task 5.9 identity derivation has no matching spec. | peer-session-bus/spec.md | Auto-apply: add requirement for transport-session binding (covered by critical caller-identity fix above). |
| consistency | Retention wording inconsistent between spec and design. | design.md | Auto-apply: clarify design — JSONL stays append-only. |
| design | Session-registry vs agent-registry separation is by-convention. | design.md | Drop — minor refactor / implementation detail. |
| design | Tool-naming inconsistency (mailbox/inbox/messages). | proposal.md | Drop — style only, existing verbs are clear. |
| design | `notifier` enum in register_session couples to implementation set. | peer-session-bus/spec.md | Drop — enum is fine for v1, two implementations. |
| completeness | `replyTo` chains unbounded / cyclic. | peer-session-bus/spec.md | Drop — document elsewhere as best-effort opaque pointer. |
| design | `send_message` has three delivery semantics (direct, broadcast, queue-to-unregistered). | design.md | Drop — subsumed by pending-cap fix and escalation. |

### Escalations (3)

The following require a design decision from the change owner before I apply fixes.

**E1 — Broadcast durability across restart**
Two incompatible approaches, both coherent:
- **Option A (codex-peer)**: materialise per-recipient delivery records at send time. On `send_message({to:"all"})`, the coordinator writes N separate log lines (one per currently-registered session). Deterministic replay; but broadcasts to the registered set at send time — new peers registering later never see the broadcast.
- **Option B (claude-design)**: store `to:"all"` verbatim as one log line. At `read_messages` time, a caller is shown all broadcasts newer than its registration timestamp. Broadcast-to-all is "real", newcomers catch up, but the unread set for a given caller is computed dynamically — more complex, more expressive.

Pick one; then I spec it.

**E2 — Retention model**
Two reviewers flagged the retention-resurrection bug. Three fixes were proposed; they are alternatives, not complementary:
- **Option A — watermark**: keep messages.jsonl append-only but record a per-session `readWatermark` (highest messageId known-read) in registry.json. Reconciliation only considers messages newer than the watermark. Small, restart-safe; retains all log content on disk.
- **Option B — compaction**: pair retention pruning with a periodic messages.jsonl rewrite. Durable, but adds a compaction code path and disk-pressure spikes.
- **Option C — defer**: drop retention from this change entirely. Log grows unbounded; operators rotate externally. Simplest; matches v1-minimalism stance elsewhere.

Default recommendation: **Option C** (defer). Revisit in a later change if log growth becomes an operational issue.

**E3 — workflow-event body schema**
- **Option A** — body is schema-free JSON; specs note consumers parse defensively. Matches v1-minimalism; every future event is zero-cost.
- **Option B** — require `body = { event: string, …rest }` with an initial enum of event names (`worktree-created`, `phase-change`, `ship-requested`, `merge-complete`) that the companion sysdig-pov-docs change will emit. Stronger contract; forces both changes to evolve together.

Default recommendation: **Option A** (schema-free), because the event vocabulary belongs to the opsx workflow, not the bus — and this change is about transport, not semantics.

### Dropped (4)
Style/implementation-detail items left for future polish (tool naming, branded types, notifier enum coupling, replyTo chain documentation).

---

## What happens next

The volume of auto-apply fixes is large (35). Applying them serially would significantly restructure the proposal — the caller-identity fix alone touches every tool scenario, and the body-size / rate-limit / pending-cap / TTL additions extend the Zod schema and `mcp-config.json` example substantially. Rather than apply incrementally, I recommend:

1. **Owner decides the three escalations above** (E1, E2, E3) — my defaults are noted.
2. **I rewrite proposal.md, design.md, and the four specs in a single pass** incorporating all 35 auto-apply fixes plus the owner's escalation choices. Tasks.md gets a corresponding rewrite.
3. **Re-run `openspec validate`**, then the owner re-opens the review gate if desired.

This is cleaner than 35 serial edits and ensures the specs remain internally consistent through the revision.
