## Context

The coordinator's `register_session` MCP tool currently requires `paneToken` as a tool argument. This was designed to give each tmux pane a stable credential so that re-registration after `/clear` or coordinator restart works without the prior session token. However, Claude Code's sandbox prevents tool arguments that contain credential-shaped values from appearing in the transcript — a correct security constraint. The model cannot pass `$COORDINATOR_SESSION_TOKEN` as a tool parameter without it being blocked.

Claude Code already has a safe mechanism for per-connection credentials: header expansion. Headers in `.mcp.json` are expanded from env vars at connection time by the Claude Code process, never by the model, and never appear in conversation context. `Authorization: Bearer ${COORDINATOR_AUTH_TOKEN}` already uses this path. The pane token should use the same path.

The current architecture: `serverFactory` is a zero-argument closure called per SSE connection inside `startHttpServer`. The SSE connection's `req` object is available at connection time but is not currently threaded into the factory or the `PeerBusContext` built inside `createCoordinatorServer`.

## Goals / Non-Goals

**Goals:**
- Pane token flows from env var → Claude Code header expansion → HTTP header → server PeerBusContext → `register_session` handler, never through a tool argument
- `register_session` tool schema takes only `{ name }` — no credential in any tool parameter
- Consumer `.mcp.json` addition is a one-line `headers` block; no other consumer changes required
- `COORDINATOR_SESSION_TOKEN` set by `start-team-session.sh` (already done) continues unchanged
- All existing registry logic (paneTokenHash, timingSafeEqual, eviction) preserved — only the delivery path changes

**Non-Goals:**
- Streamable HTTP transport support (covered by `coordinator-streamable-http` change; that change will follow the same header pattern)
- Auto-wake mechanism changes
- `start-team-session.sh` changes (already generates and exports `COORDINATOR_SESSION_TOKEN`)

## Decisions

### Thread paneToken through serverFactory parameter, not closure

`startHttpServer` receives a `serverFactory` callback. The simplest threading path is to change the factory signature from `() => McpServer` to `(paneToken?: string) => McpServer`. The SSE handler extracts `req.header('x-pane-token')` and passes it to the factory. The factory (in `src/index.ts`) passes it into `createCoordinatorServer` options, which adds it to `PeerBusContext`.

**Alternative considered: closure capture via a wrapper factory**
The SSE handler could create a new closure for each connection: `const boundFactory = () => serverFactory(paneToken)`. This avoids changing `startHttpServer`'s signature. Rejected — it obscures the data flow and makes `startHttpServer` harder to test in isolation. Explicit parameter is clearer.

**Alternative considered: read header inside `createCoordinatorServer` by passing the request object**
Pass the full Express `Request` into `createCoordinatorServer`. Rejected — ties the server factory to Express internals and breaks the existing test pattern where servers are constructed without a live HTTP request.

### Header name: `X-Pane-Token`

Lowercase `x-pane-token` in Node.js (Express normalises all headers to lowercase). The header is coordinator-specific and not a standard; `X-` prefix is appropriate. Not `Authorization` (that header is already used for the transport-level auth token and has a specific `Bearer` scheme Claude Code parses).

### Validation: same rules as before, different error code path

The server validates the extracted header value with the same constraints as before (must be present, 32–512 bytes). If the header is absent or empty, `register_session` returns `invalid_pane_token_missing`. If present but hash-mismatched against a live entry, returns `invalid_pane_token`. These error codes are unchanged from the `peer-bus-pane-token-auth` design — only the delivery mechanism changes.

### `paneToken` on PeerBusContext is optional (`string | undefined`)

Not every `register_session` call will have the header set — operators running without the launcher, or testing directly, won't have it. When absent:
- Fresh name (no registry entry): registration succeeds with no `paneTokenHash` stored (legacy unowned semantics)
- Existing entry with stored `paneTokenHash`: returns `invalid_pane_token_missing`

This preserves backward compatibility for direct MCP clients that don't supply the header.

## Risks / Trade-offs

**Risk: Streamable HTTP transport doesn't thread headers the same way**
→ Mitigation: `coordinator-streamable-http` is a separate in-progress change. When it lands, it should follow the same pattern — extract `x-pane-token` from the initial `POST /mcp` request and thread it into the factory. The factory signature change made here (`serverFactory(paneToken?)`) directly supports that path.

**Risk: Header absent on the `/message` POST (SSE two-endpoint model)**
The SSE transport uses two HTTP endpoints: `GET /sse` (opens stream) and `POST /message` (client sends JSON-RPC). The `x-pane-token` is only present on `GET /sse`. The server must capture it at SSE connection time and associate it with the per-connection `McpServer` instance — not re-read it on each `/message` POST. This is naturally handled by the factory-per-connection pattern: the header is read once at `GET /sse`, bound into the `McpServer` via `PeerBusContext`, and remains for the lifetime of the connection.

**Risk: Consumer `.mcp.json` may not support `headers` in all Claude Code versions**
→ Mitigation: Header expansion in `.mcp.json` is a documented Claude Code feature already used for `Authorization`. No version concern for current deployment.

**Trade-off: paneToken no longer supplied per-call**
Previously the model could (in theory) use a different paneToken per `register_session` call. With connection-level binding, the paneToken is fixed for the connection lifetime. This is strictly better — it prevents a compromised prompt from supplying a different credential mid-session.

## Migration Plan

1. Update `src/server/index.ts`: change `serverFactory` type to `(paneToken?: string) => McpServer`; extract and normalize `x-pane-token` in SSE handler (empty string and values outside 32–512 bytes → `undefined`); pass to factory
2. Update `src/index.ts`: change the `makeServer` arrow from `() => createCoordinatorServer(opts)` to `(paneToken?: string) => createCoordinatorServer({ ...opts, paneToken })`. The `paneToken` argument is supplied per-connection by `startHttpServer`; `src/index.ts` does not extract it from the request — it only receives it as a factory parameter.
3. Update `CoordinatorServerOptions` to include `paneToken?: string`; update `PeerBusContext` to include `paneToken?: string`. `CoordinatorServerOptions` is used as a per-call spread `{ ...opts, paneToken }` — each factory invocation creates a new object, so `paneToken` is effectively per-connection despite living on the options type.
4. Update `src/core/session-registry.ts`: change `register()` signature to accept `paneToken: string | undefined`. Make `paneTokenHash` storage conditional on `paneToken !== undefined`. Preserve constant-time comparison by using the existing `ZERO_SENTINEL` path when `paneToken` is `undefined`.
5. Update `src/server/tools/peer-bus.ts`: remove `paneToken` from `RegisterSessionParams`; remove dead `paneToken` branch from `mapRegisterZodError`; add runtime guard at start of `registerSessionTool` — if `ctx.paneToken === undefined` and the registry entry has a `paneTokenHash`, return `invalid_pane_token_missing` before calling `register()`; read pane token from `ctx.paneToken` in the normal registration path
6. Update consumer `.mcp.json` in `consumer-repo` (all worktrees share the same file via git)
7. Update `peer-bus-session` SKILL.md across all consumer repos: `register_session({ name })` — no token arg
8. Update tests

No coordinator restart required for operators already running — the server-side registry accepts the new flow on first reconnect. Consumers that haven't updated `.mcp.json` will send `register_session({ name })` without a pane token, which succeeds as legacy unowned registration until they update.

## Open Questions

None — design is fully determined by the header expansion mechanism already in Claude Code.
