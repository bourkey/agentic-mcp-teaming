## MODIFIED Requirements

### Requirement: `serverFactory` accepts an optional `paneToken` parameter threaded from the SSE connection

The `startHttpServer` function's `serverFactory` callback SHALL have the signature `(paneToken?: string) => McpServer`. The SSE connection handler SHALL extract the `x-pane-token` header from the `GET /sse` request and pass it as the `paneToken` argument when invoking `serverFactory`. The factory SHALL forward the value into `CoordinatorServerOptions` and subsequently into `PeerBusContext`.

#### Scenario: Factory receives paneToken on authenticated connection
- **WHEN** a `GET /sse` request arrives with both a valid `Authorization: Bearer` token and an `X-Pane-Token` header
- **THEN** the SSE handler SHALL pass the `X-Pane-Token` value to `serverFactory(paneToken)`; the resulting `McpServer` SHALL have `PeerBusContext.paneToken` set to that value

#### Scenario: Factory receives undefined when header absent
- **WHEN** a `GET /sse` request arrives without an `X-Pane-Token` header
- **THEN** `serverFactory(undefined)` SHALL be called; `PeerBusContext.paneToken` SHALL be `undefined`

#### Scenario: POST /message does not re-supply paneToken
- **WHEN** a client sends JSON-RPC via `POST /message` with any `X-Pane-Token` header value
- **THEN** the server SHALL use the paneToken from the originating `GET /sse` connection, not from the `POST /message` header

### Requirement: Consumer `.mcp.json` coordinator entry includes `X-Pane-Token` header

The coordinator server entry in consumer `.mcp.json` SHALL include a `headers` block with `"X-Pane-Token": "${COORDINATOR_SESSION_TOKEN}"`. Claude Code SHALL expand the env var reference at connection time. No code change is required in the coordinator to support this — it is a client-side configuration change only.

#### Scenario: Claude Code expands header at connection time
- **WHEN** Claude Code opens an SSE connection to the coordinator with `COORDINATOR_SESSION_TOKEN` set in the shell environment
- **THEN** the `X-Pane-Token` header sent SHALL contain the resolved token value, not the literal string `${COORDINATOR_SESSION_TOKEN}`

#### Scenario: Env var unset — header sent as empty string
- **WHEN** `COORDINATOR_SESSION_TOKEN` is not set in the shell environment
- **THEN** Claude Code SHALL send `X-Pane-Token: ` (empty value); the server SHALL treat an empty header as absent (`paneToken: undefined`)

**Note:** A whitespace-only header value SHALL also be treated as absent after trimming. The literal unexpanded string `${COORDINATOR_SESSION_TOKEN}` (9 bytes) is shorter than the 32-byte minimum and therefore also treated as absent by the length floor — no special case is needed for that scenario.

**Implementation note:** The `paneToken` binding is per-`McpServer` instance created once at `GET /sse` connection time. The `POST /message` handler routes to the correct `McpServer` instance via `sessionId` (tracked in the `transports` map in `startHttpServer`). The `POST /message` handler never reads `X-Pane-Token` from the POST request. `COORDINATOR_SESSION_TOKEN` is generated per pane by `start-team-session.sh` in the consumer repository (`consumer-repo`) and is not part of this coordinator repository.
