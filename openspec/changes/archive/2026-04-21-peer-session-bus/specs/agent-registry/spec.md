## ADDED Requirements

### Requirement: Session registry is runtime-populated, Map-backed, and structurally distinct from the agent registry

The coordinator SHALL maintain a session registry that is independent of the configuration-declared agent registry (`mcp-config.json → agents`). The in-memory registry SHALL be a `Map<string, SessionEntry>` (never a plain JavaScript object) so that keys read from disk cannot pollute `Object.prototype` via `__proto__` / `constructor` / similar. The registry SHALL be populated exclusively through `register_session` calls at runtime, SHALL persist to `sessions/<coord-session>/registry.json`, and SHALL NOT cause the coordinator to exit with an error when empty. Entries SHALL have no automatic relationship to entries in the agent registry, even when names coincide. `invoke_agent` SHALL NOT read from, write to, or otherwise interact with the session registry.

#### Scenario: Empty session registry does not fail startup
- **WHEN** `peerBus.enabled: true` and no session has ever registered
- **THEN** the coordinator SHALL start successfully with an empty session registry, unlike the agent registry which requires at least one entry with `canRevise: true` and one with `canImplement: true`

#### Scenario: Name collision is permitted and ignored
- **WHEN** an agent named `implementer` exists in `mcp-config.json → agents` AND a live session also calls `register_session({ name: "implementer" })`
- **THEN** both registries SHALL hold the name independently; `invoke_agent("implementer", …)` SHALL continue to spawn a fresh CLI subprocess per its existing behaviour and SHALL NOT route through the session registry

#### Scenario: invoke_agent does not mutate session registry
- **WHEN** `invoke_agent` is called
- **THEN** the coordinator SHALL NOT create, update, or delete any entries in the session registry

#### Scenario: Map-backed registry resists prototype pollution
- **WHEN** `registry.json` contains a JSON structure whose `sessions` object includes the key `"__proto__"`
- **THEN** loading SHALL NOT add any property to `Object.prototype`; the load routine SHALL iterate entries explicitly and the `__proto__` key SHALL fail the session-name regex and be skipped with a logged error

### Requirement: Session registry entries record only what is needed to resume identity and deliver mail

Each session registry entry SHALL contain exactly the following fields:

- `name` — string matching `^[a-z0-9][a-z0-9-]{0,62}$`.
- `tokenHash` — SHA-256 hex of the currently-valid session token, or empty string if the coordinator has just loaded from disk (pre-first-register-this-process).
- `registeredAt` — UTC ISO-8601 timestamp (trailing `Z`) of the first `register_session` call for this name (preserved across token rotations and coordinator restarts).
- `lastSeenAt` — UTC ISO-8601 timestamp, updated on every successful tool call by or addressed to this session.
- `unreadMessageIds` — ordered list of `messageId` strings (append order), bounded at runtime by `PEER_BUS_MAX_UNREAD = 10000` entries.

No other fields are persisted. In particular, no `role`, no `worktreePath`, no `notifier` type, no `notifierFailures` counter, no `pending[]` queue, no `readMessageIds` (read ids are not tracked at all — drain removes them from `unreadMessageIds` and the coordinator does not remember they were delivered).

#### Scenario: Entry fields after registration
- **WHEN** `register_session({ name: "frontend" })` is called for the first time and the resulting entry is inspected in `registry.json`
- **THEN** the entry SHALL contain exactly `name`, `tokenHash`, `registeredAt`, `lastSeenAt`, and `unreadMessageIds` (empty) and SHALL NOT contain any other field

#### Scenario: No readMessageIds persisted or retained
- **WHEN** `frontend` receives a message and then calls `read_messages` to drain it
- **THEN** the drained `messageId` SHALL be removed from `unreadMessageIds` and SHALL NOT be retained in any per-session read set in memory or on disk; a second lookup SHALL find no trace of that id in the registry

#### Scenario: lastSeenAt updates on every authenticated call
- **WHEN** a session calls `send_message` or `read_messages` with a valid `sessionToken`
- **THEN** the coordinator SHALL update that session's `lastSeenAt` before returning

#### Scenario: lastSeenAt updates on incoming delivery
- **WHEN** `send_message` from session `main` targets `frontend` successfully
- **THEN** the coordinator SHALL update `frontend`'s `lastSeenAt` as well (delivery counts as activity for the recipient)

#### Scenario: Unread list is capped
- **WHEN** `frontend`'s `unreadMessageIds` is at length 10 000 and another session calls `send_message({ to: "frontend", ... })`
- **THEN** `send_message` SHALL return `mailbox_full` and SHALL NOT append to either the log or the unread list

### Requirement: Session registry persists across coordinator restart; tokens do not

On coordinator startup with `peerBus.enabled: true`, the coordinator SHALL load `sessions/<coord-session>/registry.json` if present and reconstruct the in-memory `Map<string, SessionEntry>` by iterating the stored `sessions` object explicitly (never by direct assignment into a bare object). The coordinator SHALL clear `tokenHash` to the empty string on every loaded entry — no pre-restart token SHALL validate after a restart. Registered names, `registeredAt`, `lastSeenAt`, and `unreadMessageIds` SHALL survive intact subject to the reconciliation in the `peer-session-bus` capability.

A session reconnecting after restart re-registers under the same name to receive a fresh token; since the stored `tokenHash` is empty, the re-registration SHALL succeed without requiring `priorSessionToken`. Its unread list is preserved. The preserved unread list MAY include messages whose original sender session has since re-registered or disappeared; `replyTo` targeting is best-effort and receivers MUST NOT assume the sender is still reachable.

#### Scenario: Registered sessions persist across clean restart
- **WHEN** the coordinator is cleanly restarted and `registry.json` contains three session entries
- **THEN** immediately after startup the in-memory `Map` SHALL contain those three entries with `tokenHash` emptied; all other fields intact

#### Scenario: Old tokens invalid after restart
- **WHEN** a client presents a `sessionToken` from before a coordinator restart
- **THEN** the coordinator SHALL return `invalid_session_token`

#### Scenario: Re-registration restores authentication without losing unread
- **WHEN** `frontend`'s pre-restart entry had two unread messageIds, and after restart the `frontend` client calls `register_session({ name: "frontend" })` (no `priorSessionToken`, because the loaded `tokenHash` is empty)
- **THEN** the coordinator SHALL issue a fresh token, update `tokenHash` on the existing entry, leave `unreadMessageIds` intact, and the next `read_messages` call SHALL return both prior-unread messages subject to the response-size cap

#### Scenario: Missing registry file at startup
- **WHEN** the coordinator starts with `peerBus.enabled: true` and `registry.json` does not exist
- **THEN** the coordinator SHALL initialise an empty `Map<string, SessionEntry>` and SHALL create `registry.json` lazily on the first mutation
