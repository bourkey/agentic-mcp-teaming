## Context

The `coordinator-serve-mode` change (complete, 2026-04-21) wired `startHttpServer` in [src/server/index.ts](../../../src/server/index.ts#L326-L377) to host an Express app with two routes: `GET /sse` creating a `SSEServerTransport`, and `POST /message` dispatching client postbacks by `sessionId`. That pattern follows the legacy MCP HTTP+SSE transport from spec revision `2024-11-05` — GET opens an infinite SSE stream; POST delivers JSON-RPC from the client.

MCP spec revision `2025-03-26` introduced **Streamable HTTP** as the preferred transport. In Streamable HTTP a single endpoint handles all three HTTP methods: POST for client-to-server JSON-RPC (optionally streaming back via SSE), GET for opening a server-initiated SSE stream, DELETE for terminating a session. The transport is session-aware via an `Mcp-Session-Id` response header returned on `initialize`. Modern MCP clients (Claude Code's `type: "http"`, Anthropic SDK HTTP transport, the `mcp` CLI's `--transport http`) speak only Streamable HTTP.

`@modelcontextprotocol/sdk@1.27.1` — already a dependency — ships `StreamableHTTPServerTransport` with a single `handleRequest(req, res, parsedBody)` entry point and the same one-transport-per-`McpServer` constraint we already handle via the factory-per-connection pattern.

Constraints from the existing codebase:
- `startHttpServer` takes a `serverFactory: () => McpServer` and calls it per SSE connection. This pattern extends directly to Streamable HTTP — one factory call per initialised session.
- `isAuthorizedRequest(req, authToken)` in [src/server/index.ts](../../../src/server/index.ts#L58-L61) is transport-agnostic — it reads `Authorization: Bearer` or the `token` query parameter. Reusable as-is on `/mcp`.
- The existing SSE transport teardown listens for `res.on("close", ...)` and closes the per-connection `McpServer`. Streamable HTTP's `handleRequest` manages its own response lifecycle; we hook into `transport.onclose` instead.
- Tests in `tests/multi-client-transport.test.ts` exercise concurrent SSE clients via the SDK's `SSEClientTransport`. The equivalent Streamable HTTP test uses `StreamableHTTPClientTransport` from `@modelcontextprotocol/sdk/client/streamableHttp.js`.

The peer-bus tools (`register_session`, `send_message`, `read_messages`, `report_tokens` if `coordinator-client-cli` lands first) are transport-agnostic — they operate on the `SessionRegistry` and `MessageStore` regardless of which HTTP transport delivered the call. No peer-bus code changes in this scope.

## Goals / Non-Goals

**Goals:**
- Serve both MCP transports concurrently on distinct paths (`/sse` for legacy, `/mcp` for Streamable HTTP).
- Zero behaviour change for existing SSE clients (VSCode extension, `coordinator-client-cli` in flight, any `type: "sse"` `.mcp.json`).
- Enable modern `type: "http"` clients (Claude Code, others) with a single URL-path change on their side.
- Kill the `SyntaxError` failure mode where a mis-pathed client triggers the SDK's OAuth discovery fallback and crashes on Express HTML — respond with JSON.

**Non-Goals (this change):**
- Deprecating, removing, or migrating the SSE transport.
- Implementing MCP authorization (OAuth 2.0). The coordinator remains token-gated via `Authorization: Bearer` as today.
- Serving `.well-known/oauth-authorization-server` metadata. The JSON 404 catch-all is a correctness fix for the SDK's HTML-parsing crash, not a real OAuth implementation.
- DNS rebinding protection (the SDK ships `createMcpExpressApp` for this; separate follow-up).
- Method-based dispatch on a unified path (e.g. `/` serving SSE on GET-with-`text/event-stream`, Streamable HTTP otherwise). Rejected in D1.
- Server-initiated SSE streams via Streamable HTTP's `GET /mcp`. The SDK supports it; we accept connections but do not push server-initiated notifications in this change (peer-bus notifications already flow through the tmux notifier, not MCP notifications).

## Decisions

### D1 — Two paths (`/sse` and `/mcp`), not a unified endpoint

The legacy SSE transport at `/sse` and the Streamable HTTP transport at `/mcp` are served from distinct Express routes with independent session maps. Each client picks its transport by URL.

**Alternative considered**: unified path (`/`) with method-based dispatch — `GET` with `Accept: text/event-stream` lands on legacy SSE, anything else on Streamable HTTP. Rejected on two counts: (a) the URL already ships in VSCode extension config and `coordinator-serve-mode` spec text as `/sse`, so we cannot quietly repurpose `/` without breaking discovery; (b) method-sniffing hides the transport choice and makes triage harder when a client fails. Explicit paths are cheaper to reason about.

### D2 — Stateful Streamable HTTP, not stateless

`sessionIdGenerator: randomUUID`. Each `initialize` on `POST /mcp` creates a new session id, a new `McpServer` via the existing factory, and a new `StreamableHTTPServerTransport` stored in a `Map<sessionId, transport>`.

**Alternative considered**: stateless mode (`sessionIdGenerator: undefined`) with one shared `McpServer`. Rejected — the SDK's `McpServer.connect()` enforces one transport per instance, the exact constraint that motivated the factory-per-connection pattern in `coordinator-serve-mode`. Stateless would require either unsafe sharing or constructing a fresh `McpServer` per HTTP request (expensive, breaks tool state assumptions). Stateful matches the model we already validated.

### D3 — Independent session maps per transport

`transports` (existing, for SSE) and `streamableTransports` (new, for Streamable HTTP) are separate `Map<sessionId, …>` instances. Session ids from the two transports never collide because they live in different maps indexed by different routes; we never cross-look-up.

**Alternative considered**: unified session map keyed by sessionId with a `TransportKind` discriminator. Rejected — no code path needs to treat the two transport kinds symmetrically, and unifying the map would invite subtle bugs where SSE postbacks accidentally reach a Streamable HTTP transport (or vice versa).

### D4 — Body limit: 64kb for SSE `/message`, 1mb for Streamable HTTP `/mcp`

The SSE `POST /message` endpoint keeps its `express.json({ limit: "64kb" })` limit as today — one JSON-RPC message per POST. The Streamable HTTP `/mcp` endpoint uses `express.json({ limit: "1mb" })` because the spec explicitly permits clients to batch JSON-RPC requests in a single POST.

**Alternative considered**: a single `1mb` limit everywhere. Rejected — enlarging the SSE `/message` limit would relax a constraint that has proven safe and has no driver. Transport-specific limits match transport-specific semantics.

### D5 — JSON 404 catch-all scoped to OAuth-discovery paths only

The catch-all matches the exact paths that the MCP SDK's auth discovery probes — `/register`, `/authorize`, `/token`, `/.well-known/oauth-authorization-server`, `/.well-known/oauth-protected-resource` — and returns `404` with `Content-Type: application/json` and body:

```json
{"error": "not_found", "error_description": "oauth_not_supported"}
```

`error` is the OAuth 2.0 standard error-code field so the SDK's error parser populates something useful instead of crashing. `error_description` uses snake_case per RFC 6749 §5.2.

**Alternative considered**: replace Express's default 404 globally with a JSON one. Rejected — too broad; would swallow legitimate 404s from mis-configured operators and make troubleshooting harder.

**Alternative considered**: return `401 Unauthorized` with `WWW-Authenticate: Bearer` from the OAuth paths to steer the client back to token auth. Rejected — that would trigger the client's OAuth metadata discovery path on the very next request and loop us. A flat `404 not_found` is the clean "we don't do OAuth" signal.

### D6 — Connection lifecycle: `transport.onclose` for Streamable HTTP, `res.on("close")` kept for SSE

SSE transports bind to a single `res` object (the infinite event stream) so `res.on("close", ...)` is the right signal. Streamable HTTP transports outlive any single HTTP request — the session is logical, not bound to a response — so we hook `transport.onclose` (which fires on `DELETE` or on internal transport errors) to remove from the map and close the per-session `McpServer`.

**Alternative considered**: idle-timeout reaper (close transports with no activity for N minutes). Rejected for now — not a correctness concern in single-operator deployments; revisit if we see leaked sessions in practice.

### D7 — No config surface

Both transports are always on. No `transport.streamableHttp.enabled` flag. Rationale: the only reason to disable either transport is to break clients, and we have no operator-surveyed use case for that. Keep the config schema small; revisit if a real operator asks to disable one.

### D8 — Test strategy: SDK client against live server, not mocked transport

The new tests launch the real coordinator binary in a child process (same pattern as `tests/multi-client-transport.test.ts` and `tests/serve-mode.test.ts`) and connect the SDK's `StreamableHTTPClientTransport`. Mocking the transport would verify our wiring but miss SDK-level compatibility issues (request framing, header handling, session-id echo). Live client tests catch those.

## Risks and Unknowns

- **SDK behaviour around pre-parsed bodies.** `handleRequest(req, res, parsedBody)` accepts a third-argument body same as SSE, but the interaction with `express.json` edge cases (empty body, invalid JSON, content-type quirks) needs verification. Mitigation: the coexistence test exercises both, and we set `limit: "1mb"` explicitly on the `/mcp` route.
- **Session-id header propagation.** Streamable HTTP clients read `Mcp-Session-Id` from the `initialize` response and echo it on subsequent requests. The SDK's transport handles this, but if Express or any upstream middleware strips custom headers, the whole session contract breaks. Mitigation: integration test asserts at least one follow-up request after `initialize` succeeds with the echoed header.
- **Peer-bus notifier interaction.** The tmux notifier fires on `send_message` regardless of transport. Observed during this investigation: warn `notifier-tmux: set-window-option failed` for `recipient: "main"` / `recipient: "misc"` when those tmux windows do not exist. Not new to this change, but worth noting — the coexistence test should cover a cross-transport message (SSE client sends to a Streamable HTTP client's registered name) to prove the bus does not care which transport delivered which end of the exchange.
- **VSCode extension assumptions.** The extension's `McpClient` hard-codes `SSEClientTransport` against `/sse`. This change does not touch that — SSE remains fully supported — but we should confirm with a test that the extension's exact client code-path still works after the Streamable HTTP transport is added. (Stretch; primarily covered by the existing `multi-client-transport.test.ts` remaining green.)
- **Route ordering in Express.** The JSON 404 catch-all must be registered **after** the `/sse`, `/message`, and `/mcp` routes but **before** Express's default HTML 404. Order matters for `app.use(...)` middleware; easy to get wrong. Mitigation: the `oauth-fallback-404.test.ts` asserts exact bodies and content-types.

## Migration

- **Server-side**: single coordinator restart. Both transports come up together. No data migration, no session migration, no lock-file change. Existing peer-bus sessions (registered via SSE before restart) continue to work; on reconnect they use whichever transport their client is configured for.
- **Client-side**: no forced migration. VSCode extension and any `type: "sse"` `.mcp.json` are unchanged. `type: "http"` `.mcp.json` consumers move URL path from `/sse` to `/mcp`:

  ```json
  {
    "mcpServers": {
      "coordinator": {
        "type": "http",
        "url": "http://localhost:3100/mcp"
      }
    }
  }
  ```

## Open Questions

_(None load-bearing; the D-series above closes everything we need to ship.)_
