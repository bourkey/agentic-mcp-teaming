## Why

The `peer-bus-pane-token-auth` change correctly identified that pane identity needs a stable credential surviving coordinator restarts, but placed that credential as a tool argument to `register_session` — which Claude Code's sandbox blocks because tool arguments land in the conversation transcript. Moving the pane token to an HTTP connection header (`X-Pane-Token`) solves the credential hygiene problem at the transport layer, where Claude Code already safely handles env var expansion for `Authorization: Bearer` tokens, and eliminates the need for a client CLI distribution path.

## What Changes

- **New HTTP header**: `X-Pane-Token` read from the SSE connection request at the server side; value sourced from `${COORDINATOR_SESSION_TOKEN}` env var via Claude Code's header expansion — never appears in transcript or tool args
- **`register_session` schema simplified**: `paneToken` parameter removed; tool takes only `name`; server extracts the credential from the connection-level header stored in `PeerBusContext`
- **`PeerBusContext` gains `paneToken?: string`**: populated at SSE connection time from `req.headers['x-pane-token']`; available to `register_session` handler without model involvement
- **Consumer `.mcp.json` updated**: add `"X-Pane-Token": "${COORDINATOR_SESSION_TOKEN}"` to the coordinator server headers entry
- **`peer-bus-session` SKILL.md simplified**: `register_session({ name })` — no token argument; recovery path simplified (no paneToken to re-supply)
- **`start-team-session.sh` unchanged**: already generates and exports `COORDINATOR_SESSION_TOKEN` per pane via `openssl rand -base64 32`
- **`coordinator-client-cli` withdrawn**: the only reason a CLI was needed was to pass paneToken without transcript leakage — header approach makes it unnecessary

## Capabilities

### New Capabilities

- `peer-bus-pane-token-auth`: Stable pane identity credential transmitted via `X-Pane-Token` HTTP connection header. Server-side: extracted at SSE connect time, stored in `PeerBusContext`, consumed by `register_session` handler. Client-side: set in `.mcp.json` headers block, expanded by Claude Code at connection time from `${COORDINATOR_SESSION_TOKEN}`. Hash stored in registry as `paneTokenHash` (sha256, 32 bytes); compared with `timingSafeEqual`; survives coordinator restarts.

### Modified Capabilities

- `peer-session-bus`: `register_session` tool schema changes — removes `paneToken` parameter, adds connection-header extraction path. Consumer SKILL.md registration call simplified to `register_session({ name })`.
- `mcp-integration`: SSE connection handler threads `x-pane-token` header into `PeerBusContext`; coordinator `.mcp.json` template gains `headers` block.

## Impact

- **`src/server/index.ts`**: extract `x-pane-token` from `req.headers` at SSE connection time; pass into `serverFactory` / `PeerBusContext`
- **`src/server/tools/peer-bus.ts`**: remove `paneToken` from `RegisterSessionParams` Zod schema; read from `ctx.paneToken` instead
- **`src/core/session-registry.ts`**: no change — already accepts raw token value in `register()`
- **Consumer repos**: `.mcp.json` gains `headers` block; SKILL.md `register_session` call drops `paneToken` arg
- **Tests**: update `register_session` tool tests to remove `paneToken` param; add connection-header extraction tests
- **No breaking change to the wire protocol** — `register_session` becomes simpler for callers, not more complex
