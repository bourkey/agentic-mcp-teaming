## ADDED Requirements

### Requirement: Coordinator HTTP server exposes both legacy SSE and Streamable HTTP transports

The coordinator MCP HTTP server SHALL serve two MCP transports concurrently on distinct URL paths:

- `GET /sse` and `POST /message` — legacy HTTP+SSE transport per MCP spec revision `2024-11-05`, via `SSEServerTransport`. Unchanged from the `coordinator-serve-mode` implementation.
- `POST /mcp`, `GET /mcp`, `DELETE /mcp` — Streamable HTTP transport per MCP spec revision `2025-03-26`, via `StreamableHTTPServerTransport`. Stateful mode with `sessionIdGenerator: randomUUID`.

Both transports SHALL use the same `serverFactory: () => McpServer` closure to construct per-connection `McpServer` instances; shared state (session registry, peer-bus persistence, tool allowlist) SHALL be identical across transports. Session identifiers SHALL be scoped per transport — the two transports SHALL maintain independent session maps and SHALL NOT cross-look-up sessions.

#### Scenario: Legacy SSE client connects to `/sse`
- **WHEN** an MCP client configured with `type: "sse"` and URL ending in `/sse` opens an SSE stream
- **THEN** the coordinator SHALL respond with `Content-Type: text/event-stream`, emit an `event: endpoint` message advertising `/message?sessionId=<uuid>`, and accept subsequent `POST /message` calls for that session id

#### Scenario: Streamable HTTP client connects to `/mcp`
- **WHEN** an MCP client configured with `type: "http"` and URL ending in `/mcp` POSTs a JSON-RPC `initialize` request
- **THEN** the coordinator SHALL create a new `StreamableHTTPServerTransport` and `McpServer`, respond with the `initialize` result and a generated `Mcp-Session-Id` response header, and accept subsequent POST/GET/DELETE requests echoing that header

#### Scenario: Streamable HTTP session id enforcement
- **WHEN** a `POST /mcp` request arrives with an `Mcp-Session-Id` header that does not match any active session
- **THEN** the coordinator SHALL return HTTP `404 Not Found` per the Streamable HTTP stateful contract

#### Scenario: Concurrent transports on one coordinator
- **WHEN** one SSE client is connected at `/sse` and one Streamable HTTP client is connected at `/mcp` against the same coordinator instance, each having registered a session via `register_session`
- **THEN** a `send_message` call from either client targeting the other SHALL be delivered via the peer bus and observable to the recipient via `read_messages`, regardless of which transport the sender and recipient used

#### Scenario: Auth applies uniformly on both transports
- **WHEN** `COORDINATOR_AUTH_TOKEN` is configured and a request arrives at `/sse`, `/message`, or `/mcp` without a valid `Authorization: Bearer <token>` header (or matching `?token=` query parameter)
- **THEN** the coordinator SHALL respond with HTTP `401 Unauthorized` and SHALL NOT invoke any MCP tool

#### Scenario: Streamable HTTP body size limit
- **WHEN** a `POST /mcp` request body exceeds 1 MB
- **THEN** the coordinator SHALL reject the request with HTTP `413 Payload Too Large` and SHALL NOT construct a transport for that session

### Requirement: Coordinator responds to OAuth-discovery probes with parseable JSON errors

The coordinator HTTP server SHALL return HTTP `404 Not Found` with `Content-Type: application/json` and body `{"error":"not_found","error_description":"oauth_not_supported"}` for all requests whose path matches any of:

- `POST /register`
- `POST /authorize`
- `POST /token`
- `GET /.well-known/oauth-authorization-server`
- `GET /.well-known/oauth-protected-resource`

This prevents MCP client SDKs that probe these paths during the OAuth 2.0 Dynamic Client Registration fallback from crashing on Express's default HTML 404 while parsing the response as an OAuth error JSON.

Paths outside this set SHALL continue to return Express's default HTML `404 Not Found` — this requirement SHALL NOT globally replace the default 404 behaviour.

#### Scenario: Client hits `/register` during OAuth fallback
- **WHEN** an MCP client POSTs to `/register` during its OAuth Dynamic Client Registration fallback
- **THEN** the coordinator SHALL return HTTP `404` with `Content-Type: application/json` and a body that parses as JSON with `error` equal to `"not_found"`

#### Scenario: Non-OAuth 404 unchanged
- **WHEN** a client POSTs to any path not in the OAuth-discovery set (for example `/does-not-exist`)
- **THEN** the coordinator SHALL return Express's default HTML `404` response; the JSON catch-all SHALL NOT intercept

#### Scenario: OAuth paths return parseable JSON under any method
- **WHEN** any of `/register`, `/authorize`, `/token` receives any HTTP method (GET, POST, PUT, DELETE)
- **THEN** the response body SHALL be valid JSON parseable by `JSON.parse` without throwing

### Requirement: Both transports share the same MCP tool surface

The MCP tools exposed by the coordinator (including but not limited to `register_session`, `send_message`, `read_messages`, `read_file`, `write_file`, `grep`, `glob`, `invoke_agent`, `submit_for_consensus`, `advance_phase`, `get_session_state`, `resolve_checkpoint`) SHALL be registered identically on every `McpServer` instance constructed by `serverFactory`, regardless of which transport triggered its construction. Clients SHALL observe the same tool names, schemas, and behaviours on `/sse` and `/mcp`.

#### Scenario: `tools/list` identical across transports
- **WHEN** a client calls `tools/list` via the legacy SSE transport and another client calls `tools/list` via the Streamable HTTP transport against the same coordinator instance
- **THEN** both responses SHALL contain the same set of tool names with the same input schemas
