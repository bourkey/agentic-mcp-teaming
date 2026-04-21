## Context

The coordinator today uses one-shot `execFile("claude", ["-p", prompt])` per agent turn in `src/server/tools/agents.ts`. That model cannot address live, long-running Claude Code sessions — there is no mailbox, no identity, no way to route work into an already-attached pane. The intended consumer is a tmux-based opsx workflow in a sibling repository (`sysdig-pov-docs`), where three area worktrees (`frontend`, `backend`, `misc`) plus a `main` driver run as persistent panes and today coordinate only through the human walking between them.

Prior rounds of this proposal scoped a larger bus (broadcasts, pending queues for unregistered names, pluggable notifiers, retention, heartbeat/TTL, deregistration, selective reads). Review rounds 1 and 2 together found ~70 distinct issues across security, completeness, consistency, and design. Rather than patch each, this revision **narrows v1 to the minimum that is defensible end-to-end**. Each deferred feature becomes its own small proposal when the need is concrete.

Constraints carried from the existing codebase:
- MCP is pull-only; the coordinator cannot wake a session.
- `execFile` with an argument array is the only sanctioned subprocess invocation pattern. `bash` stays off by default.
- All filesystem paths flow through `assertWithinRoot`.
- Auth tokens are compared with `timingSafeEqual`.
- `mcp-config.json` is the single source of truth, validated by Zod with strict parsing.

## Goals / Non-Goals

**Goals:**
- Three MCP tools — `register_session`, `send_message`, `read_messages` — that let live Claude Code sessions exchange typed events and chat messages.
- Transport-independent, cryptographically-enforced caller identity: capability tokens issued at registration, proof-of-continuity required to rotate the token on an active name, and constant-time authentication that cannot be used as a timing oracle for registry inspection.
- Hard compile-time caps on body size (64 KiB), unread list length (10 000), and response size (1 MiB).
- Defence-in-depth against envelope-break injection, tmux format-language expansion, and prototype pollution.
- Zero behavioural change when `peerBus` is absent from `mcp-config.json`.
- A single-instance guarantee enforced by a filesystem lock with clean cleanup on every Node exit path.
- Coexistence with the existing consensus workflow; the bus does not route `invoke_agent` traffic.

**Non-Goals (this change):**
- Broadcasts (`to: "all"`).
- Queueing messages to unregistered names; any pending queue.
- `list_sessions`, `mark_read`, `deregister_session`, `whoami`, or any staleness/TTL mechanism.
- Pluggable notifier interface. Only tmux, and only when explicitly enabled.
- Selective reads via `since` (removed after round 2 — use follow-up proposal if needed).
- An in-memory "read messages" set beyond what `unreadMessageIds` already tracks. Read drains; nothing else is kept.
- Message retention, log compaction, or rotation.
- Rate limiting.
- Restart-survivable capability tokens (restart invalidates all tokens; every client must re-register).
- Any modification of `invoke_agent`, `invoke_reviewer`, the consensus loop, or filesystem tools.
- Any change to the VS Code extension.

## Decisions

### D1 — Reads drain totally; no mark_read, no since, no read-set

`read_messages({ sessionToken })` returns every unread envelope for the caller, up to `PEER_BUS_MAX_RESPONSE_BYTES`, AND atomically removes their ids from `unreadMessageIds`. If the response size cap is reached before the unread list is exhausted, the tool returns `hasMore: true` and the remaining ids stay in `unreadMessageIds` for the next call.

There is no separate acknowledgement tool. There is no `since` parameter. There is no in-memory `readMessageIds` set; once an id is removed from `unreadMessageIds`, the coordinator does not remember it was ever delivered to that session.

**Why**: `mark_read` doubles the tool surface. `since` reintroduces selective reads, which are functionally close to the deferred non-draining-read feature. An in-memory `readMessageIds` grows without bound for the process lifetime and serves no protective purpose under the per-session mutex. All three are cut.

**Trade-off**: lossy under network failure. If the opsx workflow starts depending on reliable acknowledgement, add `mark_read` in a follow-up change.

### D2 — Direct messages only; must be registered

`send_message.to` MUST name a currently-registered session. Sending to an unknown name returns `recipient_not_registered`. There is no `"all"` broadcast and no pending queue for unregistered names.

**Why**: eliminates the broadcast-race, pending-queue-bloat, and reconciliation-durability findings. The tmux launcher orders things so the bus is "fully open" before `main` starts dispatching; the sender-aware retry cost is acceptable.

### D3 — Capability token + proof-of-continuity

`register_session({ name, priorSessionToken? })` returns `{ name, sessionToken, registeredAt }`. The token is 256 bits from `crypto.randomBytes(32)`, encoded as base64url. The coordinator stores only `sha256(rawToken)` as `tokenHash`. Every subsequent `send_message` and `read_messages` call MUST include `sessionToken`; authentication is described in D3a below.

Re-registration rules:

- **Fresh name** (no existing registry entry): `priorSessionToken` MUST be absent; the call succeeds and issues a token.
- **Existing name with non-empty `tokenHash`** (an active token holder): `priorSessionToken` MUST be present and match the stored `tokenHash` via `timingSafeEqual`. A match rotates the token (invalidates the prior). A mismatch returns `invalid_prior_session_token_required`. This prevents any transport-authed client from hijacking another session's name.
- **Existing name with empty `tokenHash`** (loaded from disk after coordinator restart, no active owner): `priorSessionToken` MUST be absent; the call succeeds, populates `tokenHash`, and preserves `unreadMessageIds`.

Coordinator restart wipes all `tokenHash` values on load; every client re-registers on startup. A client that loses its token without the coordinator restarting cannot recover ownership — the coordinator SHALL NOT provide an automated recovery path (this is an operator-intervention case: delete the registry entry or restart the coordinator).

**Why**: the priorSessionToken check closes the round-2 name-hijack finding. Wiping tokens on restart avoids persisting a high-value credential to disk. A stranded client (rare) becomes an operator ticket rather than silently accepting any re-registration.

### D3a — Constant-time authentication with no registry-state leakage

On every `send_message` and `read_messages` call:

1. Compute `h = sha256(sessionToken)` (32 bytes).
2. For every registry entry, compute `isMatch = timingSafeEqual(h, entry.tokenHash || ZERO_SENTINEL)` where `ZERO_SENTINEL = Buffer.alloc(32, 0)`.
3. Accumulate `matchedEntry = isMatch ? entry : matchedEntry`. Do NOT `break` on match.
4. After the full loop, return `matchedEntry` or `null`.

Using a zero-byte sentinel for empty `tokenHash` entries ensures every iteration performs one `timingSafeEqual`, so the wall-clock cost of authentication is `O(N)` regardless of whether any entry matches or where a matching entry sits in iteration order.

**Why**: round 2 caught the early-exit + empty-hash-shortcut pair as a timing oracle for registry position and live-session enumeration. Full iteration with sentinel comparison closes both leaks.

### D4 — Envelope: XML-escape all peer-controlled content; strip XML 1.0 illegal chars first

`read_messages` returns each message as `{ messageId, wrapped }` where `wrapped` is:

```
<peer-message from="{from}" kind="{kind}" messageId="{messageId}">{body}</peer-message>
```

Rendering pipeline for each substituted value:

1. For object bodies (workflow-event), serialise to compact JSON first.
2. Strip XML 1.0 illegal control chars: `/[\x00-\x08\x0B\x0C\x0E-\x1F]/g` → `""`.
3. XML-escape: `&` → `&amp;`, `<` → `&lt;`, `>` → `&gt;`, `"` → `&quot;`, `'` → `&apos;`.

**Why**: XML-escape alone (round 1 fix) handles the boundary-break case but leaves the envelope potentially invalid XML if a future consumer validates strictly. Control-char stripping closes that gap.

### D5 — Store persists PeerMessage records with UTC-Z timestamps; envelope is rendered at read

`messages.jsonl` contains one JSON object per line: `{ messageId, from, to, kind, body, replyTo?, timestamp }`. `timestamp` MUST be a UTC ISO-8601 string with the literal trailing `Z` (no non-zero offsets). The `<peer-message>` envelope text is NEVER on disk. The tool handler is the single rendering site.

Ordering and `since`-style filtering are NOT applied in v1 (`since` is not accepted), but consumers should know: wherever comparisons are needed, the coordinator parses via `Date.parse()` — never compares raw ISO-8601 strings — so differing offsets cannot misorder.

**Why**: separates persistence (append-only JSON) from presentation (XML envelope). Standardising on UTC avoids offset/DST traps.

### D6 — Compile-time caps on body, mailbox, and response

Three compile-time constants in `src/core/message-store.ts` and `src/core/session-registry.ts`:

| Constant | Value | Enforced by | Error code |
|---|---|---|---|
| `PEER_BUS_MAX_BODY_BYTES` | 65536 | `send_message` before append | `payload_too_large` |
| `PEER_BUS_MAX_UNREAD` | 10000 | `send_message` before unread-list push | `mailbox_full` |
| `PEER_BUS_MAX_RESPONSE_BYTES` | 1048576 | `read_messages` during drain | `hasMore: true` partial return |

None are configurable.

**Why**: body cap stops OOM via one message; unread cap stops flood-DoS on a slow reader; response cap respects MCP transport limits and avoids huge single responses. All three as constants because operator tuning is a footgun.

### D7 — `workflow-event` body contract

When `kind === "workflow-event"`, `body` MUST be a JSON object with a required non-empty `event: string` field. Other fields are free. Enforced at the Zod boundary; violations return `invalid_workflow_event_body`.

### D8 — Single-instance lock with PID as diagnostic-only

At startup with `peerBus.enabled: true`, the coordinator calls `fs.openSync(<sessionsDir>/coordinator.lock, 'wx')` and writes `pid=<process.pid>`. On `EEXIST`, the coordinator best-effort-reads the file (to include the prior PID in the error message) and exits fatally.

Cleanup is registered on: `SIGINT`, `SIGTERM`, `process.on('exit')`, `process.on('uncaughtException')` (after logging), and `process.on('unhandledRejection')` (after logging). Each handler reads the lock file; if `pid=<n>` matches `process.pid`, the file is unlinked. If it doesn't match (the lock was replaced by a new coordinator after a racy shutdown), the old handler leaves it alone.

The PID is diagnostic-only — the coordinator SHALL NOT steal the lock based on PID-liveness checks. `SIGKILL` or hardware crash leaves a stale lock; operator intervention is required.

**POSIX assumption**: `O_EXCL|O_CREAT` is assumed atomic. Operators running on NFS-pre-v3, some overlay filesystems, or other filesystems without this guarantee SHALL NOT enable `peerBus`. This is documented in the spec and README.

### D9 — Per-session async mutex with lexicographic lock order

Each bus-tool invocation takes the mutex for the caller's session name. Operations that touch a second session (`send_message` updates the recipient's `unreadMessageIds`) take the second mutex too, with the pair acquired in lexicographic order regardless of which is caller and which is recipient. The ordering is fixed so that `zeta → alpha` and `alpha → zeta` concurrent sends cannot deadlock.

The natural mutation order inside the critical section (update caller lastSeenAt → append to log → update recipient unreadMessageIds) is independent of lock acquisition order. Implementers MUST acquire locks first, then mutate in the order that makes sense for the operation.

### D10 — Fire-and-forget tmux notifier AFTER releasing mutexes

When `peerBus.notifier.tmuxEnabled: true`, after a successful `send_message` append-and-unread-update, the handler:

1. Releases the per-session mutexes.
2. Kicks the notifier as a detached Promise.
3. Returns `{ messageId }` to the caller without awaiting the notifier.

The notifier itself shells out twice via `execFile("tmux", [...])` with a 5-second timeout per subprocess. The format string is built by substituting `{from}` and `{kind}` into `peerBus.notifier.displayMessageFormat` after scrubbing each value with `/[#\`$;&|\n\r]/g → ""`. The config-time format string is Zod-validated at load against `/^[^#\`$;&|\n\r]*$/`.

Notifier failures (ENOENT, non-zero exit, timeout) are caught and logged as warning entries to `audit.log` with the recipient name and failure mode. Caller latency is independent of notifier latency.

**Why**: round 2 caught the mutex-held-during-notifier case as a serialisation point that could delay all sends to a recipient when tmux hangs. Fire-and-forget eliminates that. Trade-off: the `send_message` caller has no way to detect notifier failure synchronously — audit log is the only signal.

### D11 — Persistence layout and reconciliation

```
sessions/<coord-session>/
├── state.json         (existing; untouched)
├── audit.log          (existing; untouched)
├── snapshots/         (existing; untouched)
├── coordinator.lock   (NEW; O_EXCL file, contents "pid=<n>")
├── messages.jsonl     (NEW; append-only, one PeerMessage per line, UTC-Z timestamps)
└── registry.json      (NEW; rewrite-on-change via temp+rename)
```

`registry.json` contains `{ sessions: { [name]: { name, tokenHash, registeredAt, lastSeenAt, unreadMessageIds } }, version: 1 }`. The in-memory registry is a `Map<string, Entry>` — never a plain object — to preclude prototype pollution via hand-edited `registry.json`.

**Startup reconciliation** verifies EACH unread messageId by both existence and addressee:

1. Load `messages.jsonl`, building an index `messageId → PeerMessage`.
2. Load `registry.json`; clear every `tokenHash`.
3. For each session's `unreadMessageIds`:
   - If the id is not in the index → drop it (orphan).
   - If the id IS in the index but `message.to !== session.name` → drop it (misrouted).
   - Otherwise keep it.
4. Emit ONE aggregate audit-log warning summarising: `{ orphanedCount, misroutedCount, firstFewIds: [...] }`. Do NOT emit one warning per dropped id.

**Partial persistence** edge cases:

- `registry.json` exists, `messages.jsonl` does not → treat log as empty; every unread id is orphaned and dropped; registry reduces to name-only entries.
- `messages.jsonl` exists, `registry.json` does not → start with empty registry; log is retained on disk but nothing is deliverable until clients register.

### D12 — Config schema (Zod)

```ts
peerBus: z.object({
  enabled: z.boolean().default(false),
  notifier: z.object({
    tmuxEnabled: z.boolean().default(false),
    displayMessageFormat: z.string()
      .regex(/^[^#`$;&|\n\r]*$/, "format string may not contain tmux format-language sequences or shell metacharacters")
      .default("peer-bus: from {from} kind {kind}"),
    unreadTabStyle: z.string()
      .regex(/^[A-Za-z0-9=,._-]+$/, "unreadTabStyle must be a simple tmux style spec")
      .default("bg=yellow"),
  }).strict().default({}),
}).strict().optional()
```

New entries in the default `toolAllowlist`: `register_session`, `send_message`, `read_messages`. Operators remove any of those names to disable the corresponding tool.

### D13 — Module contracts

The implementation is factored into five modules with sharp boundaries:

| Module | Owns | Does NOT |
|---|---|---|
| `src/core/message-store.ts` | append-only JSONL I/O, UTC timestamp generation, `computeBodyByteLength`, body-size enforcement | touch the registry |
| `src/core/session-registry.ts` | name → entry `Map`, per-session mutex, `authenticate(token)`, `addUnread(name, id)`, `drainUnread(name, maxBytes, messageLookup)` returning `{messages, hasMore}`, `persist()` | read `messages.jsonl` |
| `src/core/notifier-tmux.ts` | `fireTmuxNotifier({recipient, from, kind, format, tabStyle, logger})` only; pure function, no state | hold any mutex; import any session-state module |
| `src/core/coordinator-lock.ts` | `acquireCoordinatorLock(sessionsDir)` returning a release function; exit-path handler registration | read peer-bus state |
| `src/server/tools/peer-bus.ts` | orchestration: parse params, authenticate, acquire mutexes, call store + registry, release mutexes, fire notifier, emit audit log, wrap MCP response | any file I/O not routed through the modules above |

Every module in `src/core/` receives a `Logger` interface (`{ warn, error, info }`) from its factory or first call — no module imports `src/session/audit-logger.ts` directly. This also makes tests trivial: inject a capturing logger.

### D14 — Error response shape

Every peer-bus tool error response SHALL match:

```
{
  content: [{ type: "text", text: JSON.stringify({ error: <code>, message: <human-readable> }) }],
  isError: true
}
```

Stable error code enum (no others permitted):

`invalid_session_name`, `invalid_session_token`, `invalid_prior_session_token_required`, `invalid_recipient_name`, `recipient_not_registered`, `payload_too_large`, `mailbox_full`, `invalid_workflow_event_body`, `response_internal_error`.

Success responses follow the existing convention: `{ content: [{ type: "text", text: JSON.stringify(<result>) }] }` with no `isError` field.

### D15 — Client recovery protocol

Clients that receive `invalid_session_token` from `send_message` or `read_messages` SHALL:

1. Call `register_session({ name: <self> })` — no `priorSessionToken` — ONCE.
2. Retry the original call with the new token.
3. If the retry also fails with `invalid_session_token`, a different client has claimed the name (the first registration rotated the token, then the attacker re-rotated before this client's retry arrived). Surface the condition to the operator and stop retrying.
4. If the first `register_session` fails with `invalid_prior_session_token_required`, another client has already taken ownership (registry has a fresh `tokenHash`). Surface to operator; do not loop.

This is documented as a bus-side contract so the companion `sysdig-pov-docs` startup skill has one canonical pattern to implement.

### D16 — Forward-compatibility note (for follow-up proposals)

Broadcasts in a future change will choose between (a) appending the broadcast `messageId` to every registered session's `unreadMessageIds` at send time (simple but requires lock-all-recipients), or (b) keeping broadcasts in a separate channel with a per-session read-watermark (more code, no N-lock). v1 does not foreclose either — adding a watermark column to registry entries is an additive change that does not conflict with v1 invariants.

`list_sessions`, `whoami`, `mark_read`, `since` filters, and `deregister_session` are all similarly additive: none requires changing the persistence layout, the token lifecycle, or the identity contract.

### D17 — Known limitations (explicit)

- **Idle sessions do not auto-process messages.** MCP is pull-only. A session receives a message only when it next invokes `read_messages`. The tmux notifier visually cues the human operator; the companion skill will instruct sessions to read at turn start.
- **At-most-once delivery.** Reads drain. Network failure between coordinator and client loses the response.
- **Coordinator restart invalidates all tokens.** Every client re-registers on startup. Unread lists survive.
- **Stale-recipient notifications accumulate.** Sending to a name whose pane has exited still appends to its unread list and still fires the tmux subprocess (which fails and is logged). Operators notice via the warning pattern; no automatic stale-session detection in v1.
- **Lock cleanup after `SIGKILL` is manual.** `coordinator.lock` survives hard-kill; operators delete it after confirming no coordinator is running.
- **POSIX filesystem required.** `O_EXCL|O_CREAT` must be atomic; NFS-pre-v3 and some overlay filesystems are unsupported.
- **Response size cap means large mailboxes need multiple reads.** When `hasMore: true`, clients loop.

## Risks / Trade-offs

- **Risk**: reads-drain loses messages on network failure.
  **Mitigation**: document. Add `mark_read` in a follow-up if needed.

- **Risk**: priorSessionToken recovery impossible for a client that lost its token without coordinator restart.
  **Mitigation**: document as operator-intervention case. An automated recovery path would re-introduce the hijack vulnerability.

- **Risk**: authentication cost is `O(N)` per call; large registries slow.
  **Mitigation**: `N` is bounded by the number of tmux panes actively using the bus (single-digit in the intended use case). If N grows beyond ~100, a hash-prefix index becomes worthwhile — follow-up change.

- **Risk**: fire-and-forget notifier means the `send_message` caller cannot detect notifier failures synchronously.
  **Mitigation**: notifier failures are warned in `audit.log`. Operators notice via log pattern; the bus itself continues to function.

- **Risk**: `mailbox_full` on a flooded recipient blocks a legitimate sender.
  **Mitigation**: this is the correct behaviour. 10 000 is large enough for any realistic workflow; a sender seeing `mailbox_full` should stop and investigate.

- **Risk**: the `messages.jsonl` log grows without bound.
  **Mitigation**: operators rotate externally. Retention proposal welcome later.

- **Risk**: prompt injection via peer messages.
  **Mitigation**: `<peer-message>` envelope + control-char stripping + XML escape + companion skill that trains sessions to treat envelope contents as data, not instructions. Defence-in-depth, not a full fix.

- **Risk**: a malicious client with the transport token AND knowledge of an inactive coordinator (restart scenario, `tokenHash` empty) can claim any name before the legitimate client re-registers.
  **Mitigation**: the window is small (startup reconciliation → first re-register). The transport token is the primary defence; this is an accepted residual risk of the "restart wipes all tokens" decision.

## Migration Plan

Additive change. No data migration.

1. Merge this change. Existing deployments without `peerBus` in config see zero behavioural change.
2. Operators opt in by adding `"peerBus": { "enabled": true, "notifier": { "tmuxEnabled": true } }` to `mcp-config.json`.
3. The companion `sysdig-pov-docs` change will add the launcher script that starts tmux panes, the startup skill that calls `register_session` on first turn and implements the client recovery protocol.

Rollback: remove `peerBus` from config (or set `enabled: false`), restart the coordinator. `sessions/<id>/messages.jsonl` and `registry.json` may be left on disk or deleted — they are no longer read.

## Open Questions

None outstanding. The three escalations from round 1 were closed by scope narrowing in round 2's rewrite; the two criticals and thirteen majors from round 2 were closed by auto-apply fixes incorporated directly into this revision.
