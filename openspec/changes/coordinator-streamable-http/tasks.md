## 1. Wire Streamable HTTP transport into `startHttpServer`

- [ ] 1.1 In [src/server/index.ts](../../../src/server/index.ts), import `StreamableHTTPServerTransport` from `@modelcontextprotocol/sdk/server/streamableHttp.js` and `randomUUID` from `node:crypto`.
- [ ] 1.2 Add a second session map alongside the existing one: `const streamableTransports = new Map<string, StreamableHTTPServerTransport>()` and `const streamableServers = new Map<string, McpServer>()`.
- [ ] 1.3 Register a single Express route handling all three methods: `app.all("/mcp", express.json({ limit: "1mb" }), (req, res) => { ... })`. The handler SHALL:
  - Call `isAuthorizedRequest(req, authToken)` first; respond `401 Unauthorized` if it returns false.
  - Read the `Mcp-Session-Id` request header; if present, look up the existing transport from `streamableTransports`.
  - If no session id and the body is an `initialize` request, construct a new `StreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID() })`, construct a new `McpServer` via `serverFactory()`, connect them, and store in the two maps keyed by the transport's assigned session id.
  - Delegate to `transport.handleRequest(req, res, req.body)`.
  - On the transport's `onclose` handler, remove from both maps and `await server.close()`, logging any error via `console.error`.
- [ ] 1.4 Preserve the existing `/sse` and `/message` routes unchanged. Verify by running `npm test` before any new tests are added — the current `tests/multi-client-transport.test.ts` MUST continue to pass.

## 2. JSON 404 catch-all for OAuth-discovery paths

- [ ] 2.1 After all MCP routes are registered, add a middleware that matches the exact paths `/register`, `/authorize`, `/token`, `/.well-known/oauth-authorization-server`, `/.well-known/oauth-protected-resource` (both GET and POST) and responds with HTTP `404`, `Content-Type: application/json`, and body `{"error":"not_found","error_description":"oauth_not_supported"}`.
- [ ] 2.2 Do NOT replace Express's default 404 for other paths. Unmatched non-OAuth paths SHALL continue to return Express's default HTML 404.

## 3. Tests — Streamable HTTP transport

- [ ] 3.1 `tests/streamable-http-transport.test.ts` — launch the coordinator in a child process (same harness as `tests/multi-client-transport.test.ts`), use the SDK's `StreamableHTTPClientTransport` from `@modelcontextprotocol/sdk/client/streamableHttp.js` to connect two concurrent clients, each performs `initialize` + `register_session`, each receives a distinct session token. Shut down cleanly with `SIGTERM`.
- [ ] 3.2 `tests/streamable-http-transport.test.ts` — single-client happy path: `initialize`, call `register_session`, call `send_message` to self, call `read_messages`, assert round-trip.
- [ ] 3.3 `tests/streamable-http-transport.test.ts` — session id echo: after `initialize`, a subsequent `tools/list` call with the echoed `Mcp-Session-Id` header succeeds; a call with a bogus `Mcp-Session-Id` returns `404` per the SDK's stateful contract.
- [ ] 3.4 `tests/streamable-http-transport.test.ts` — auth: with `COORDINATOR_AUTH_TOKEN=abc123` set in the child env, a request without `Authorization: Bearer abc123` returns `401 Unauthorized`; the same request with the correct bearer succeeds.

## 4. Tests — Coexistence

- [ ] 4.1 `tests/transport-coexistence.test.ts` — one coordinator instance: connect one `SSEClientTransport` client and one `StreamableHTTPClientTransport` client concurrently. Both `register_session` successfully and get distinct session tokens.
- [ ] 4.2 `tests/transport-coexistence.test.ts` — cross-transport message: the SSE-connected client `send_message`s to the Streamable-HTTP client's registered name; the HTTP client's `read_messages` returns the message. Prove the peer bus is transport-agnostic.

## 5. Tests — OAuth fallback

- [ ] 5.1 `tests/oauth-fallback-404.test.ts` — `POST /register`, `POST /authorize`, `POST /token`, `GET /.well-known/oauth-authorization-server`, `GET /.well-known/oauth-protected-resource` all return HTTP `404`, `Content-Type: application/json`, body exactly `{"error":"not_found","error_description":"oauth_not_supported"}`.
- [ ] 5.2 `tests/oauth-fallback-404.test.ts` — `POST /does-not-exist` (any non-OAuth path) returns Express's default HTML 404, unchanged.
- [ ] 5.3 `tests/oauth-fallback-404.test.ts` — `JSON.parse(body)` succeeds for every OAuth-path response, proving the SDK's error parser will not crash on the output.

## 6. Documentation

- [ ] 6.1 `README.md` — add a "Transports" section under the coordinator deployment docs documenting both `/sse` (legacy HTTP+SSE) and `/mcp` (Streamable HTTP). Include example `.mcp.json` snippets for both `type: "sse"` (URL ending `/sse`) and `type: "http"` (URL ending `/mcp`).
- [ ] 6.2 `CLAUDE.md` — update the "Architecture overview" pointer for `src/server/index.ts` to mention both transport routes.

## 7. Final verification

- [ ] 7.1 `npm run build && npm test` — all tests green, no regressions in `tests/multi-client-transport.test.ts` or any existing test.
- [ ] 7.2 Manual smoke test: start `npm start -- serve`, point a `type: "http"` `.mcp.json` at `http://localhost:3100/mcp`, connect from Claude Code, run `register_session`, `send_message`, `read_messages`. Confirm no OAuth error cascade.
- [ ] 7.3 Manual smoke test: point a `type: "sse"` client (VSCode extension or a second Claude Code config) at the same running coordinator at `http://localhost:3100/sse`. Confirm SSE path still works identically.
