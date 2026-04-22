## Why

The `peer-session-bus` and `coordinator-serve-mode` changes produced a working MCP server and a way to run it. But every consuming project still has to implement its own client-side plumbing: token cache, stale-token recovery, envelope parsing, and metrics extraction from the underlying agent CLI. That's the wrong division of labour — it duplicates the auth/recovery logic across every adopter and it ties the bus to Claude Code's hook API.

This change moves those primitives into the `coordinator` binary itself as CLI subcommands. After this lands, any consuming project — Claude Code panes, Codex CLIs, a Python agent harness, a bash cron job, anything that can `exec` — adopts the bus by invoking `coordinator register`, `coordinator send`, `coordinator read`, `coordinator report-tokens`. Project-specific integration shrinks to a launcher and a handful of one-line command invocations. Token-usage metrics, which the user asked for as an informational signal, ride in as one more subcommand (`report-tokens`) and one more server-side tool (`report_tokens`) that appends to a `metrics.jsonl` file alongside the existing `messages.jsonl`.

The architectural shift: the `coordinator` binary becomes both sides of the bus — server subcommands (`serve`, `start`, `status`) AND client subcommands (`register`, `send`, `read`, `report-tokens`). One binary, CLI-agnostic, language-agnostic adoption for any downstream tenant.

## What Changes

### New client CLI subcommands on the `coordinator` binary

- `coordinator register [--name <name>] [--prior-token <token>] [--coordinator-url <url>] [--quiet]` — calls `register_session` against the coordinator. Caches `{ coordinatorUrl, sessionToken, registeredAt }` to `$XDG_RUNTIME_DIR/coordinator/<name>.token` (falls back to `$TMPDIR/coordinator/<name>.token` on macOS where XDG isn't standard), with owner-only file permissions (0o600). Name is read from `COORDINATOR_SESSION_NAME` env var if `--name` is absent. Coordinator URL is read from `COORDINATOR_URL` env var if `--coordinator-url` is absent, falling back to `http://127.0.0.1:3100/sse`. Prior token reads from env `COORDINATOR_PRIOR_SESSION_TOKEN` if flag absent; explicit flag wins. On success, prints `sessionToken` to stdout unless `--quiet`.
- `coordinator send --to <name> --kind <kind> --body <json-or-text> [--reply-to <uuid>] [--name <name>]` — reads the cached token for `--name` (or `COORDINATOR_SESSION_NAME`), calls `send_message`, prints `messageId` to stdout. `--body` accepts a string; if the string parses as JSON, the JSON value is sent; otherwise the raw string. Exit status: 0 on success, non-zero with error code on stderr on failure.
- `coordinator read [--wrap-for-prompt] [--name <name>]` — reads the cached token, calls `read_messages`, prints results. Default output: a JSON array of `{ messageId, wrapped }` objects. With `--wrap-for-prompt`: emits the wrapped envelopes concatenated inside a single `<peer-inbox>…</peer-inbox>` block ready to prepend to a model prompt (or empty string if no messages).
- `coordinator report-tokens --input <n> --output <n> [--cache-read <n>] [--cache-create <n>] [--model <m>] [--name <name>]` — reads the cached token, calls the new `report_tokens` MCP tool (see below). All token counts are non-negative integers; the delta is taken at face value (self-reported, informational). `--model` is a free-form string (e.g. `claude-opus-4-7`).
- `coordinator deregister [--name <name>]` — clears the local token cache file for `<name>`. Does NOT call the coordinator (there is no `deregister_session` tool yet); purely local cache cleanup. Used by launchers on pane exit via tmux hooks.

### Built-in stale-token recovery

All four authenticated subcommands (`send`, `read`, `report-tokens`, and re-registrations) follow the spec's client recovery protocol: on `invalid_session_token`, call `register` once (without `--prior-token`) to rotate; retry the original call once with the new token; if the retry ALSO returns `invalid_session_token` or the recovery register returns `invalid_prior_session_token_required`, surface to the operator on stderr and exit non-zero. The protocol is identical across every subcommand; the consuming project never implements it.

### New server-side MCP tool: `report_tokens`

- `report_tokens({ sessionToken, delta: { input, output, cacheRead?, cacheCreate? }, model, reportedAt? })` — records a token-usage delta for the caller. The payload is small, validated at the Zod boundary (all integers non-negative, `model` a string, `reportedAt` an optional ISO-8601 UTC timestamp; if absent, coordinator stamps). Returns `{ ok: true, totalThisSession: { input, output, cacheRead, cacheCreate } }` with in-memory aggregates for the caller.
- The tool participates in the existing auth flow (transport token at the HTTP layer, session token at the handler), touches `lastSeenAt` on authenticated call, and uses the standard error shape (`invalid_session_token`, `response_internal_error`).

### New persistence: `metrics.jsonl`

- `sessions/<coord-session>/metrics.jsonl` — append-only, one JSON object per line, fsync on every write (same discipline as `messages.jsonl`). Each line: `{ messageId: null, session, delta: {...}, model, reportedAt }`. No retention in v1 (operators rotate externally, same as the message log).
- In-memory aggregates per session: `{ input, output, cacheRead, cacheCreate, lastReportAt }` on the `SessionRegistry` entry. Reconstructed from `metrics.jsonl` at startup by a new pass alongside the existing `messages.jsonl` reconciliation.

### Config additions

- Add `peerBus.metrics` to the Zod schema: `{ enabled: boolean (default true when peerBus.enabled), metricsFile: string (default "metrics.jsonl") }`. `.strict()` as everywhere else. Absent block → defaults. A consumer who doesn't want metrics disables `peerBus.metrics.enabled` and the `report_tokens` tool is not registered.
- Add `report_tokens` to the documented default `toolAllowlist`.

### Token cache file format

A single JSON file per session name at `$XDG_RUNTIME_DIR/coordinator/<name>.token` (or `$TMPDIR/coordinator/<name>.token` on platforms without XDG):

```json
{
  "name": "frontend",
  "coordinatorUrl": "http://127.0.0.1:3100/sse",
  "sessionToken": "<base64url>",
  "registeredAt": "2026-04-22T09:47:41.023Z",
  "writtenBy": 73092
}
```

Mode 0o600. Unlinked by `coordinator deregister`. The file is the integration point: any downstream tool that wants to use the bus can read this file for a valid token, bypassing the CLI if it needs to.

### Extensibility conventions (documented, not code)

- **Env vars** consumers set: `COORDINATOR_URL`, `COORDINATOR_SESSION_NAME`, `COORDINATOR_AUTH_TOKEN` (when the transport token is configured).
- **Cache location**: `$XDG_RUNTIME_DIR/coordinator/` (or `$TMPDIR/coordinator/`).
- **Event vocabulary**: consumers pick their own. `workflow-event` body schema remains `{ event: string, ...rest }` from the original bus spec.

## Capabilities

### Modified Capabilities
- `peer-session-bus`: adds the `report_tokens` MCP tool, the `metrics.jsonl` persistence, the in-memory token aggregates on registry entries, and the config schema additions for `peerBus.metrics`.
- `mcp-integration`: adds four new client-side CLI subcommands (`register`, `send`, `read`, `report-tokens`, plus `deregister` as a local cache operation). Documents the coordinator binary as a dual-role server+client binary.

## Impact

- **New code**:
  - `src/client/` directory with one file per subcommand: `register.ts`, `send.ts`, `read.ts`, `report-tokens.ts`, `deregister.ts`, plus `client-config.ts` (env var resolution) and `token-cache.ts` (the file I/O + path resolution).
  - `src/client/mcp-client.ts` — a thin HTTP+SSE MCP client used by the CLI subcommands (reusing the SDK's client where possible; otherwise a minimal handwritten call).
  - `src/client/recovery.ts` — the stale-token recovery protocol implementation shared across the authenticated subcommands.
  - `src/server/tools/peer-bus.ts` — new `reportTokensTool` handler.
  - `src/core/metrics-store.ts` — append-only `metrics.jsonl` reader/writer with the same shape as `MessageStore` (renameable: could also be unified under a single `JsonlAppendStore` abstraction, covered in design).
- **Modified code**: `src/index.ts` (register new subcommands + rename existing ones under a consistent CLI surface); `src/config.ts` (add `peerBus.metrics` block); `src/core/session-registry.ts` (add `tokenAggregate` field to entries); `src/core/peer-bus-bootstrap.ts` (initialise metrics store alongside message store); `src/server/index.ts` (register `report_tokens` tool conditionally).
- **Persistence**: one new file per coordinator session (`metrics.jsonl`), a small token cache file per consumer session (in `$XDG_RUNTIME_DIR/coordinator/` on the consuming machine).
- **Tests**:
  - Unit tests for each subcommand (mocking the MCP client so behaviour is testable without a running coordinator).
  - Subprocess-based integration tests (spawn a real coordinator in `serve` mode via the existing `tests/serve-mode.test.ts` pattern, run each subcommand against it, assert round-trip behaviour — register → send → read → report-tokens).
  - Stale-token recovery test: rotate the token out-of-band, invoke a client subcommand, assert it recovers transparently.
  - Metrics-store unit tests (append, loadAll, aggregate reconstruction).
- **Docs**:
  - `readme.md` gains an "Integration guide" section showing how a downstream project adopts the bus (env vars, token cache, reference launcher snippet, example hook invocations). Kept CLI-agnostic: example snippets for Claude Code hooks AND a generic shell-script example.
  - `CLAUDE.md` gains a "Client subcommands" section mirroring the existing "Peer session bus" block.
- **Backwards compatibility**: fully additive. Existing `serve`, `start`, `status` subcommands unchanged. Existing `peerBus` config works unchanged (metrics default-enabled but inert without `report-tokens` calls).
- **Explicitly out of scope (follow-ups)**: a `coordinator scaffold` subcommand that drops a starter integration into a consuming project (wait until we have 2+ real consumers before blessing a template); a `get_metrics` MCP tool for in-coordinator queries (grep `metrics.jsonl` is enough for v1); a `list_sessions` companion; a `deregister_session` MCP tool (local cache cleanup is enough for v1); cost calculation / price-table maintenance (store raw tokens, consumers compute dollars); any form of budget enforcement (explicitly not a decision-driving system — informational only).

## The sysdig-pov-docs companion proposal shrinks

The earlier draft of `peer-bus-integration` for sysdig-pov-docs had ~6 sub-bullets of client-side plumbing (token cache module, launcher script with env-var propagation, startup skill with recovery logic). After this change lands, that proposal collapses to: (a) a launcher calling `coordinator register --quiet` per tmux window; (b) a small skill teaching the model about envelope semantics and adding the `coordinator read --wrap-for-prompt` / `coordinator report-tokens ...` calls at turn boundaries; (c) one-line `coordinator send` edits in the four opsx skills. That's the whole consumer-side integration.
