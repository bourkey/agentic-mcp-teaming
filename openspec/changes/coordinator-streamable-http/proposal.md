## Why

MCP spec revision `2025-03-26` superseded the legacy HTTP+SSE transport with **Streamable HTTP**, and modern MCP clients — including Claude Code's `.mcp.json` with `"type": "http"` — now speak Streamable HTTP by default. The coordinator, shipped in `coordinator-serve-mode`, only implements the legacy transport (`GET /sse` for the event stream, `POST /message` for client postbacks via `SSEServerTransport`). When a Streamable-HTTP client points at our `/sse` URL, it POSTs JSON-RPC to that path, receives Express's default HTML 404 (`Cannot POST /sse`), enters its OAuth 2.0 Dynamic-Client-Registration fallback, POSTs to `/register` — another HTML 404 — and finally fails with a `SyntaxError` trying to parse the HTML as an OAuth error JSON. The symptom surfaces as an authentication error; the root cause is a missing transport.

This is a real spec gap, not a nice-to-have. The transport split between SSE and Streamable HTTP is the upstream MCP reality, the SDK we already depend on (`@modelcontextprotocol/sdk@1.27.1`) ships `StreamableHTTPServerTransport` as a drop-in, and every new MCP client adopter will hit the same 404-masquerading-as-OAuth wall until the server speaks both transports. The VSCode extension and the in-flight `coordinator-client-cli` both assume SSE, so we cannot replace — only add.

## What Changes

### New route: `POST|GET|DELETE /mcp` — Streamable HTTP transport

- `StreamableHTTPServerTransport` from `@modelcontextprotocol/sdk@1.27.1` wired into `startHttpServer` alongside the existing SSE route. Stateful mode (`sessionIdGenerator: randomUUID`) — matches the existing per-connection `McpServer` factory pattern that `coordinator-serve-mode` established.
- Single Express handler dispatching all three methods to `transport.handleRequest(req, res, req.body)`. `POST` delivers JSON-RPC, `GET` opens the optional server-initiated SSE stream, `DELETE` terminates a session.
- Per-connection `McpServer` instances, same factory closure as the SSE route. No shared state between transports; two independent `Map<sessionId, transport>` stores.
- Body limit on `/mcp`: `1mb` (Streamable HTTP clients can send batch JSON-RPC payloads larger than the `64kb` SSE limit). Documented as a constant, not config.

### Preserved route: `GET /sse` + `POST /message` — legacy HTTP+SSE transport

- **Unchanged.** Same handler, same session map, same body limit, same auth gate.
- VSCode extension's `McpClient` and any `type: "sse"` client config continue to work without any client-side change.

### New: JSON 404 catch-all for MCP-adjacent paths

- A final Express middleware that, for requests whose path matches the MCP-client OAuth-fallback footprint (`/register`, `/authorize`, `/token`, `/.well-known/oauth-*`), returns `404 Not Found` with `Content-Type: application/json` and body `{"error": "not_found", "message": "oauth_not_supported"}`. This prevents the exact `SyntaxError` chain that motivated this change: a misconfigured MCP client gets a parseable JSON error instead of Express HTML that the SDK crashes on.
- All other unmatched paths continue to fall through to Express's default 404 — we do not globally replace Express's not-found behaviour.

### Auth

- The existing `isAuthorizedRequest(req, authToken)` gate applies identically on `/mcp`. `Authorization: Bearer <token>` is the same contract; no new auth surface.

### Tests

- `tests/streamable-http-transport.test.ts` — two concurrent Streamable-HTTP clients, each performs `initialize` + `register_session`, each receives distinct session tokens. Mirrors `tests/multi-client-transport.test.ts` but uses the SDK's `StreamableHTTPClientTransport`.
- `tests/transport-coexistence.test.ts` — one coordinator instance serves one SSE client and one Streamable-HTTP client simultaneously; both successfully register, send, and read messages via the peer bus.
- `tests/oauth-fallback-404.test.ts` — `POST /register`, `POST /authorize`, `POST /token`, and `GET /.well-known/oauth-protected-resource` all return 404 with `Content-Type: application/json` and a parseable OAuth-compatible error body.

### Docs

- `README.md`: new transport section documenting both `/sse` (legacy) and `/mcp` (Streamable HTTP). Example `.mcp.json` snippets for both `type: "sse"` and `type: "http"`, including the URL change (`…:3100/sse` for SSE; `…:3100/mcp` for HTTP).
- `CLAUDE.md`: update the architecture overview pointer to reference both transports.

## Capabilities

### Modified Capabilities
- `mcp-integration`: adds a second HTTP transport (Streamable HTTP at `/mcp`) alongside the existing SSE transport at `/sse`, and formalises that the coordinator SHALL respond to OAuth-discovery probes with parseable JSON errors rather than HTML 404s so client SDKs can degrade cleanly when no auth is configured.

## Impact

- **New code**: ~60 LoC in [src/server/index.ts](../../../src/server/index.ts) for the `/mcp` route, ~10 LoC for the JSON 404 catch-all. No new modules.
- **Reused code**: `serverFactory`, `isAuthorizedRequest`, the session/registry/peer-bus wiring — all unchanged. The new route is a sibling of the SSE route, not a replacement.
- **New dependencies**: none. `StreamableHTTPServerTransport` is already in `@modelcontextprotocol/sdk@1.27.1`, which is already a dependency.
- **Tests**: three new test files (~350 LoC total); existing `tests/multi-client-transport.test.ts` unchanged.
- **Docs**: README transport section + CLAUDE.md pointer.
- **Client-side migration**: no forced migration. `sysdig-pov-docs/.mcp.json` and any other `type: "http"` client moves its URL from `…/sse` to `…/mcp` and keeps `type: "http"`; `type: "sse"` clients are untouched.

## Out of Scope (explicitly deferred)

- **DNS rebinding protection**: the SDK ships `createMcpExpressApp` with this middleware. We use bare `express()` today. Worth a follow-up change; not coupled to transport support.
- **OAuth server support**: the `.well-known/oauth-protected-resource` endpoint per MCP authorization spec. Our coordinator does not require OAuth and the JSON-404 catch-all is sufficient to keep clients from crashing. True OAuth support is a separate change if we ever decide to run the coordinator against untrusted networks.
- **Deprecating the SSE transport**: the VSCode extension and the in-flight `coordinator-client-cli` still assume SSE. Revisit after both have migrated.
- **Server-side connection logging**: `/sse` / `/mcp` / `/message` currently log nothing on connect, disconnect, or 401. The pane-is-silent observability gap we hit during this investigation is real, but orthogonal to transport support. Separate change.
- **Notifier warning hardening**: the `notifier-tmux: set-window-option failed` warn does not name the target window in its persisted form; include it in the warn payload. Tiny, separate change.

## Why this is a real spec gap, not a nice-to-have

The `coordinator-serve-mode` proposal asserted "the coordinator MCP server SHALL listen on `http://<host>:<port>/sse` for MCP clients" and thereby baked a transport choice (legacy HTTP+SSE) into the spec. That was the correct choice at the time but it was written as if it were the only transport. Client SDKs have since moved to Streamable HTTP; the spec has not. This change closes that spec gap by formalising that the coordinator SHALL speak both transports over the lifetime of the deprecation window, and that OAuth-discovery probes from modern clients SHALL receive parseable JSON errors rather than HTML that crashes the SDK.
