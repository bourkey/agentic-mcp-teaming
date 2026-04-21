## ADDED Requirements

### Requirement: Coordinator exposes three peer-bus MCP tools when enabled

When `peerBus.enabled: true` in `mcp-config.json`, the coordinator SHALL register the following MCP tools — subject to each name being present in `toolAllowlist` — using the existing `server.tool(...)` registration pattern alongside `invoke_agent`, `invoke_reviewer`, filesystem, and workflow tools:

- `register_session({ name, priorSessionToken? })` — returns `{ name, sessionToken, registeredAt }`.
- `send_message({ sessionToken, to, kind, body, replyTo? })` — returns `{ messageId }`.
- `read_messages({ sessionToken })` — returns `{ messages: Array<{ messageId, wrapped }>, hasMore: boolean }`.

Each tool SHALL wrap its successful return value in the standard MCP text-content array matching the existing tool registration pattern: `{ content: [{ type: "text", text: JSON.stringify(<result>) }] }` with no `isError` field. Each tool call SHALL emit an audit log entry of type `tool_call` with the tool name, a redacted params object (see Audit Log requirement below), the coordinator session id, and a result-size indicator.

#### Scenario: Three tools registered when enabled and allowed
- **WHEN** `peerBus.enabled: true` and `toolAllowlist` contains each of `register_session`, `send_message`, `read_messages`
- **THEN** the coordinator SHALL register all three tools; an MCP client listing tools SHALL see them alongside the existing tools

#### Scenario: Tool omitted from allowlist is not registered
- **WHEN** `peerBus.enabled: true` but `toolAllowlist` omits `read_messages`
- **THEN** the coordinator SHALL NOT register `read_messages`; calls to it SHALL return the SDK's unknown-tool error

#### Scenario: Success response shape matches existing convention
- **WHEN** `register_session({ name: "frontend" })` returns `{ name: "frontend", sessionToken: "…", registeredAt: "…" }`
- **THEN** the actual MCP tool response SHALL be `{ content: [{ type: "text", text: "{\"name\":\"frontend\",\"sessionToken\":\"…\",\"registeredAt\":\"…\"}" }] }` and SHALL NOT include `isError`

### Requirement: Error response shape uses MCP SDK isError convention with a stable error-code enum

Every peer-bus tool error response SHALL be of the shape `{ content: [{ type: "text", text: JSON.stringify({ error: <code>, message: <human-readable> }) }], isError: true }`. `<code>` SHALL be one of the following stable enum values; no other codes SHALL be returned from peer-bus tools:

- `invalid_session_name` — `register_session` name failed the regex.
- `invalid_session_token` — `send_message` or `read_messages` presented a token that did not authenticate against any registry entry.
- `invalid_prior_session_token_required` — `register_session` against an existing active name either omitted `priorSessionToken` or presented one that did not match the stored `tokenHash`.
- `invalid_recipient_name` — `send_message.to` failed the regex.
- `recipient_not_registered` — `send_message.to` is a well-formed name but no session by that name is currently registered.
- `payload_too_large` — `send_message.body` exceeded `PEER_BUS_MAX_BODY_BYTES`.
- `mailbox_full` — the recipient's `unreadMessageIds` would exceed `PEER_BUS_MAX_UNREAD` after append.
- `invalid_workflow_event_body` — `send_message` with `kind: "workflow-event"` whose body is not a JSON object with a non-empty string `event` field.
- `response_internal_error` — the coordinator encountered an internal error during a tool handler (e.g. persist failure during `read_messages` drain that was successfully rolled back); the error `message` field SHALL carry a human-readable explanation.

`<message>` SHALL be a human-readable sentence safe to display; it SHALL NEVER contain the raw `sessionToken`, the raw `priorSessionToken`, or any body content.

#### Scenario: invalid_session_token error shape
- **WHEN** `send_message` is called with a token that authenticates against no entry
- **THEN** the response SHALL be `{ content: [{ type: "text", text: "{\"error\":\"invalid_session_token\",\"message\":\"<sentence>\"}" }], isError: true }`

#### Scenario: Error message never leaks tokens or bodies
- **WHEN** any peer-bus error response is produced
- **THEN** the `message` field SHALL NOT contain the raw `sessionToken`, `priorSessionToken`, or `body` value, regardless of the error code

#### Scenario: Error code enum is closed
- **WHEN** a peer-bus tool returns `isError: true`
- **THEN** the `error` field SHALL match one of the nine codes above; the coordinator SHALL NOT introduce other codes for peer-bus tools without a spec update

### Requirement: Audit log redacts tokens and hashes bodies

Audit log entries for peer-bus tools SHALL NEVER contain the raw `sessionToken` or `priorSessionToken` values — both SHALL be replaced with the literal string `"<redacted>"`. `send_message` audit entries SHALL record `{ to, kind, replyTo, messageId, bodyLength, bodyHash }` where `bodyHash` is the first 16 hex chars of `sha256(<serialised body>)` and `bodyLength` is the byte count used for the size check. Raw body content SHALL NOT appear in audit entries for any peer-bus tool. `read_messages` audit entries SHALL record `{ count, firstId, lastId, hasMore }` and SHALL NOT dump wrapped envelope strings.

Audit log entries SHALL be newline-delimited JSON objects produced via `JSON.stringify` so that any string value (names, error messages, file paths) is JSON-escaped; this precludes log injection via control characters in peer-supplied or disk-supplied data.

Additionally, `sessionToken` values SHALL NEVER appear in ANY log stream produced by the coordinator — this includes `audit.log`, `stdout`, `stderr`, and MCP SDK diagnostic output. The coordinator SHALL NOT interpolate a raw `sessionToken` into any Zod error message, any thrown error message, or any log statement. Operators running with MCP SDK verbose/debug logging enabled SHOULD disable it in production; the coordinator SHALL document this in the README.

#### Scenario: sessionToken redacted in audit entries
- **WHEN** `send_message` is called and the call is audited
- **THEN** the `audit.log` entry's `params` field SHALL contain `sessionToken: "<redacted>"` and SHALL NOT contain the actual token value

#### Scenario: priorSessionToken redacted in audit entries
- **WHEN** `register_session` is called with a `priorSessionToken` and the call is audited
- **THEN** the entry SHALL contain `priorSessionToken: "<redacted>"` regardless of whether the call succeeded

#### Scenario: send_message body hashed not stored
- **WHEN** `send_message` is called with `body: "very-secret-content"`
- **THEN** the `audit.log` entry SHALL contain `bodyLength: 19` and a 16-hex-char `bodyHash`, and SHALL NOT contain the string `"very-secret-content"`

#### Scenario: read_messages audit summarises
- **WHEN** `read_messages` returns three messages with `hasMore: false`
- **THEN** the `audit.log` entry SHALL record `{ count: 3, firstId: "<uuid>", lastId: "<uuid>", hasMore: false }` and SHALL NOT dump the wrapped strings

#### Scenario: Audit entries are newline-delimited JSON
- **WHEN** any peer-bus tool logs an entry containing a peer-supplied string (e.g. a session name after failed validation)
- **THEN** the entry SHALL be a single JSON object serialised via `JSON.stringify` and followed by exactly one newline, so control characters in the peer-supplied string cannot introduce additional log lines

### Requirement: Auth enforcement applies uniformly to peer-bus tools

The peer-bus tools SHALL be subject to the same MCP transport authentication as all other tools: when `authTokenEnvVar` is set and resolves to a non-empty token, every MCP transport connection SHALL present a matching token via `Authorization: Bearer` header or `token` query parameter. Token comparison SHALL use `timingSafeEqual`. Peer-bus tools SHALL NOT introduce any alternate transport authentication path. The per-session `sessionToken` described in the `peer-session-bus` capability is an in-band identity check layered on top of transport auth; it does not replace it.

#### Scenario: Missing transport token rejected
- **WHEN** the coordinator binds beyond loopback, `COORDINATOR_AUTH_TOKEN` is set, and an MCP client connects without presenting the token
- **THEN** the transport SHALL return 401 before any peer-bus tool can be invoked

#### Scenario: Transport comparison is timing-safe
- **WHEN** a transport token is presented that matches the configured token in length but differs in one byte
- **THEN** the coordinator SHALL reject the connection using `timingSafeEqual`

### Requirement: Configuration schema validates the peerBus block strictly

The Zod schema in `src/config.ts` SHALL include an optional top-level `peerBus` object declared with `.strict()` and the following fields:

- `enabled: boolean` — default `false`.
- `notifier.tmuxEnabled: boolean` — default `false`.
- `notifier.displayMessageFormat: string` — default `"peer-bus: from {from} kind {kind}"`. Validated at load against the regex `/^[^#\`$;&|\n\r]*$/`; violations cause coordinator startup to fail.
- `notifier.unreadTabStyle: string` — default `"bg=yellow"`. Validated at load against `/^[A-Za-z0-9=,._-]+$/`; violations cause startup to fail.

Unknown keys anywhere inside the `peerBus` block SHALL cause a Zod validation failure at load time.

#### Scenario: Absent block means disabled
- **WHEN** `mcp-config.json` does not include a `peerBus` key
- **THEN** the coordinator SHALL treat the bus as disabled and start successfully

#### Scenario: Minimal enabled config applies defaults
- **WHEN** `mcp-config.json` contains `"peerBus": { "enabled": true }`
- **THEN** `notifier.tmuxEnabled` SHALL default to `false`, `displayMessageFormat` SHALL default to `"peer-bus: from {from} kind {kind}"`, and `unreadTabStyle` SHALL default to `"bg=yellow"`; the coordinator SHALL start successfully

#### Scenario: Unknown key rejected
- **WHEN** `mcp-config.json` contains `"peerBus": { "enabled": true, "unknown": "x" }`
- **THEN** the coordinator SHALL exit with a Zod validation error naming `unknown`

#### Scenario: Unsafe displayMessageFormat rejected
- **WHEN** `mcp-config.json` contains `"peerBus": { "notifier": { "displayMessageFormat": "oops #(curl evil)" } }`
- **THEN** the coordinator SHALL exit with a Zod validation error pointing at `displayMessageFormat`

#### Scenario: Unsafe unreadTabStyle rejected
- **WHEN** `mcp-config.json` contains `"peerBus": { "notifier": { "unreadTabStyle": "; rm -rf /" } }`
- **THEN** the coordinator SHALL exit with a Zod validation error pointing at `unreadTabStyle`

### Requirement: Default tool allowlist includes the three peer-bus tools

The documented default `toolAllowlist` in `mcp-config.json` SHALL include `register_session`, `send_message`, and `read_messages` as entries. Operators MAY remove any of those names to disable the corresponding tool. Removal SHALL NOT cause the coordinator to fail — the other two tools SHALL continue to function, and attempts to call a removed tool SHALL return the SDK's unknown-tool error.

#### Scenario: All three tools allowed by default
- **WHEN** the operator adds `"peerBus": { "enabled": true }` to a config whose `toolAllowlist` was copied from the documented example
- **THEN** all three tools SHALL be registered and available

#### Scenario: Operator removes one tool
- **WHEN** the operator removes `send_message` from `toolAllowlist` while `peerBus.enabled: true`
- **THEN** `register_session` and `read_messages` SHALL be registered; `send_message` SHALL NOT; a call to `send_message` SHALL fail with the SDK's unknown-tool error
