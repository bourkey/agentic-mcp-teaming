## ADDED Requirements

### Requirement: Pane identity credential delivered via `X-Pane-Token` HTTP header

The coordinator SHALL accept a pane identity credential via the `X-Pane-Token` HTTP request header on the `GET /sse` SSE connection request. The server SHALL extract this header value at connection time, store it in `PeerBusContext.paneToken`, and make it available to the `register_session` tool handler for the lifetime of that connection. The header value SHALL NOT be re-read from subsequent `POST /message` requests.

The consumer SHALL supply the header by adding `"X-Pane-Token": "${COORDINATOR_SESSION_TOKEN}"` to the coordinator entry in `.mcp.json`. Claude Code SHALL expand the env var reference at connection time. The raw token value SHALL NOT appear in any tool argument, conversation transcript, or skill output.

The SSE handler SHALL normalize the extracted header value before storing it: an empty string or a value shorter than 32 bytes (UTF-8) SHALL be treated as absent (`paneToken: undefined`). A value longer than 512 bytes SHALL also be treated as absent. This moves the previous 32–512 byte enforcement from the Zod schema layer to the connection layer.

#### Scenario: Header present on SSE connection
- **WHEN** a client opens `GET /sse` with header `X-Pane-Token: <token>` where `<token>` is between 32 and 512 bytes (UTF-8)
- **THEN** the server SHALL store `<token>` on the `PeerBusContext` for that connection and pass it to `register_session` when called

#### Scenario: Header absent on SSE connection
- **WHEN** a client opens `GET /sse` without an `X-Pane-Token` header
- **THEN** `PeerBusContext.paneToken` SHALL be `undefined`; `register_session` SHALL treat absence as unowned-legacy semantics (no paneTokenHash stored on fresh name; `invalid_pane_token_missing` on name with existing paneTokenHash)

#### Scenario: Header present but too short
- **WHEN** a client opens `GET /sse` with `X-Pane-Token: <token>` where `<token>` is fewer than 32 bytes (e.g. an unexpanded env var reference or short test value)
- **THEN** the server SHALL treat the header as absent (`paneToken: undefined`); the short value SHALL NOT be stored in `PeerBusContext` or hashed

#### Scenario: Header value not re-read from POST /message
- **WHEN** a client sends a `POST /message` JSON-RPC request with an `X-Pane-Token` header
- **THEN** the server SHALL ignore that header; only the value captured at `GET /sse` connection time SHALL be used. The per-connection `McpServer` instance created at `GET /sse` time carries the `PeerBusContext.paneToken`; the `POST /message` handler routes to the correct instance via `sessionId` and never re-reads the header.

#### Scenario: Concurrent reconnect with same paneToken
- **WHEN** a pane reconnects while its old `GET /sse` connection is still open and both connections call `register_session({ name })`
- **THEN** both calls SHALL succeed (matching `paneTokenHash`); only the most recently issued `sessionToken` SHALL be valid for subsequent `send_message` / `read_messages` calls. The second registration implicitly invalidates the first session token.

### Requirement: `register_session` consumes paneToken from context, not from tool parameters

The `register_session` MCP tool SHALL NOT include a `paneToken` field in its input schema. The handler SHALL read the pane token from `PeerBusContext.paneToken` (set at connection time). All existing registry behaviour — paneTokenHash storage, timingSafeEqual comparison, TTL-based eviction, legacy unowned semantics — SHALL be preserved unchanged.

`SessionRegistry.register()` SHALL accept `paneToken: string | undefined`. When `paneToken` is `undefined`:
- If no registry entry exists for the name: registration succeeds with no `paneTokenHash` stored (legacy unowned semantics)
- If an entry exists with a stored `paneTokenHash`: the handler SHALL return `invalid_pane_token_missing` before calling `register()`

`paneTokenHash` storage is conditional on `paneToken !== undefined`. The constant-time comparison path SHALL still be executed against a zero sentinel when `paneToken` is `undefined` to avoid timing oracles on the existence of registry entries.

#### Scenario: Matching paneToken re-registers successfully
- **WHEN** `register_session({ name: "claude-main" })` is called on a connection whose `X-Pane-Token` matches the stored `paneTokenHash` for that name
- **THEN** the tool SHALL return a new `sessionToken` and update `lastSeenAt`

#### Scenario: Mismatched paneToken within TTL returns error
- **WHEN** `register_session({ name: "claude-main" })` is called on a connection whose `X-Pane-Token` does NOT match the stored `paneTokenHash` AND the entry is within TTL
- **THEN** the tool SHALL return `{ error: "invalid_pane_token" }` without modifying the registry entry

#### Scenario: Missing paneToken on name with stored hash returns error
- **WHEN** `register_session({ name: "claude-main" })` is called on a connection with no `X-Pane-Token` header AND the registry entry has a stored `paneTokenHash`
- **THEN** the tool SHALL return `{ error: "invalid_pane_token_missing" }`

#### Scenario: Fresh name with no header registers as legacy unowned
- **WHEN** `register_session({ name: "new-pane" })` is called on a connection with no `X-Pane-Token` header AND no registry entry exists for that name
- **THEN** registration SHALL succeed; no `paneTokenHash` SHALL be stored; the entry MAY be re-claimed by any caller (legacy unowned semantics)

### Requirement: paneToken never appears in audit logs, tool arguments, or transcripts

The `paneToken` value extracted from `X-Pane-Token` SHALL be redacted to `"<redacted>"` in all audit log entries. It SHALL NOT appear in any MCP tool argument, MCP tool result, conversation transcript, skill output, or error message. Zod validation errors on the tool schema SHALL NOT reference a `paneToken` field (because the field no longer exists on the schema).

#### Scenario: Audit log entry for register_session contains no credential
- **WHEN** `register_session` is called on a connection carrying a non-empty `X-Pane-Token`
- **THEN** the audit log entry SHALL contain `paneToken: "<redacted>"` (or omit the field entirely) and SHALL NOT contain the raw token value or its hash
