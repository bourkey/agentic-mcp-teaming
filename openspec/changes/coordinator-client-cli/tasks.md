## 1. Server-side: report_tokens tool and metrics.jsonl

- [ ] 1.1 Add `peerBus.metrics` block to the Zod schema in `src/config.ts`: `{ enabled: boolean (default true via `.default(true)`), metricsFile: string (default "metrics.jsonl") }`. `.strict()` applied. Unit tests covering defaults-when-bus-enabled, explicit opt-out, unknown-key rejection.
- [ ] 1.2 Create `src/core/metrics-store.ts` mirroring `src/core/message-store.ts`: `MetricsStore` class with `append(record)`, `loadAll()`, `getPath()`, held-open fd with fsync-per-append. Unit tests: round-trip append+load, 10-append = 10-fsync spy count, corrupt line tolerated with warning (line number / offset / length / preview).
- [ ] 1.3 Consider extracting the shared JSONL-append logic from `MessageStore` and `MetricsStore` into `JsonlAppendStore<T>`. Only refactor if the test suite still passes cleanly with minimal diff; otherwise defer and note in review-summary.
- [ ] 1.4 Extend `SessionEntry` in `src/core/session-registry.ts` with `tokenAggregate?: { input, output, cacheRead, cacheCreate, lastReportAt? }`. Initialize on register. NOT persisted to `registry.json` (the persist serialiser excludes the field). Unit test: `persistEntry + loadEntry` round-trip does NOT carry `tokenAggregate`.
- [ ] 1.5 Add `applyTokenDelta(name, delta, model, reportedAt)` method to `SessionRegistry`: under the session's mutex, mutate the aggregate in place (adding each field, defaulting cache* to 0), update `lastReportAt`. Unit test: concurrent two-delta apply sums correctly; missing session returns null without mutating anything.
- [ ] 1.6 Add `reconcileMetrics(metricsLookup)` method OR extend existing `reconcile`: read `metrics.jsonl` at startup, sum per-session, populate `tokenAggregate` on each registry entry. Tolerate corrupt lines. Unit test: 10 lines across 3 sessions produce correct aggregates; session not in registry has its lines silently ignored.
- [ ] 1.7 Create `reportTokensTool` handler in `src/server/tools/peer-bus.ts` following `sendMessageTool`'s shape: Zod-validate params; authenticate caller; reject negative deltas via Zod (non-negative integer constraint); touch caller's lastSeenAt immediately after auth; acquire caller's mutex; append to `MetricsStore`; apply delta to aggregate; persist registry (for lastSeenAt — aggregates are not persisted); return `{ ok: true, totalThisSession }`. Audit log entry: `{ tool: "report_tokens", params: { sessionToken: "<redacted>", model, delta } }`; delta is safe to log verbatim (no free-form content).
- [ ] 1.8 Zod parameter schema for `report_tokens`: `{ sessionToken, delta: { input: int>=0, output: int>=0, cacheRead?: int>=0, cacheCreate?: int>=0 }, model: string().min(1), reportedAt?: ISO-8601 regex }`. Error-code mapping per spec: unknown-field paths → `response_internal_error` (closed enum).
- [ ] 1.9 Register `report_tokens` conditionally in `src/server/index.ts`: only when `config.peerBus?.enabled === true` AND `config.peerBus?.metrics?.enabled === true` AND `"report_tokens"` in `toolAllowlist`. Add integration test that asserts registration under each combination.
- [ ] 1.10 Update `src/core/peer-bus-bootstrap.ts` to construct a `MetricsStore`, return it on the wiring, and run metrics reconciliation after message reconciliation. Log a single aggregate reconciliation line to audit if any metrics lines were loaded.
- [ ] 1.11 Update `PeerBusWiring` type in `src/server/index.ts` and `src/core/peer-bus-bootstrap.ts` to include the optional `metricsStore`. Tool handler reads it from the wiring when wiring through `PeerBusContext`.

## 2. Client subcommand: token cache

- [ ] 2.1 Create `src/client/token-cache.ts` exporting `resolveCachePath(name): string` (implements XDG → TMPDIR → /tmp precedence), `readCache(name): Promise<CacheEntry | null>`, `writeCache(name, entry): Promise<void>` (atomic via tmp + rename), `deleteCache(name): Promise<void>`.
- [ ] 2.2 Cache entry shape: `{ name, coordinatorUrl, sessionToken, registeredAt, writtenBy: number }`. On write, set file mode 0o600 and parent dir mode 0o700 on creation. On read, validate JSON shape; return null on missing or malformed (with a stderr warning on malformed).
- [ ] 2.3 Unit tests in `tests/client-token-cache.test.ts`: write-then-read round-trip; atomic rename (tmp file never observable as the live file); permissions 0o600; parent dir 0o700 on first write; missing file returns null; malformed file returns null with warning; delete unlinks idempotently.

## 3. Client subcommand: MCP client helper

- [ ] 3.1 Create `src/client/mcp-client.ts` — a small wrapper over the existing `@modelcontextprotocol/sdk/client` (or a handwritten HTTP+SSE client if the SDK client isn't convenient). Exports `callTool(url, authToken, toolName, params): Promise<unknown>`. Returns parsed JSON from the tool's text content or throws a typed `MCPToolError` with `code` + `message` when `isError: true`.
- [ ] 3.2 `MCPToolError` is an Error subclass with `.code: string` (matching the server-side error enum) and `.message: string`. Re-export for consumers.
- [ ] 3.3 Unit tests with a local HTTP mock: successful call parses text content; `isError: true` response throws `MCPToolError` with correct code; network failure throws with a generic code.

## 4. Client subcommand: recovery protocol

- [ ] 4.1 Create `src/client/recovery.ts` exporting `recoverableCall<T>(name, coordinatorUrl, authToken, fn: (token) => Promise<T>): Promise<T>`. Implementation: read cached token; call `fn(token)`; on `MCPToolError` with code `invalid_session_token`, call `register_session` (no priorSessionToken) to rotate; atomically persist new token; retry `fn(newToken)` ONCE; on second `invalid_session_token` or on `invalid_prior_session_token_required` from the recovery register, throw `RecoveryFailedError` with a clear operator-intervention message.
- [ ] 4.2 Unit tests in `tests/client-recovery.test.ts`: happy path (fn succeeds first try, no recovery invoked); single recovery (first call returns `invalid_session_token`, register succeeds, retry succeeds); recovery register returns `invalid_prior_session_token_required` → throws `RecoveryFailedError`; retry fails with `invalid_session_token` → throws; mock MCP client throughout.

## 5. Client subcommand: register/send/read/report-tokens/deregister

- [ ] 5.1 Create `src/client/register.ts` — implements the `coordinator register` action. Resolves name/URL/auth from flags + env; calls `register_session` via the MCP client (NOT via `recoverableCall` — register is always a fresh call); on success writes cache and prints token unless `--quiet`. On `invalid_prior_session_token_required`, prints a descriptive error and exits 1.
- [ ] 5.2 Create `src/client/send.ts` — `coordinator send` action. Reads cache; wraps `send_message` call in `recoverableCall`; handles `--body -` (stdin); attempts JSON.parse on body string, falls back to raw string; prints messageId on stdout on success; on error prints the error code + message on stderr and exits 1.
- [ ] 5.3 Create `src/client/read.ts` — `coordinator read` action. Reads cache; wraps `read_messages` call in `recoverableCall`. Default output: JSON array of `{messageId, wrapped}` to stdout. With `--wrap-for-prompt`: concatenates `wrapped` fields with newlines inside a single `<peer-inbox>…</peer-inbox>` block, OR emits empty string if mailbox was empty.
- [ ] 5.4 Create `src/client/report-tokens.ts` — `coordinator report-tokens` action. Reads cache; wraps `report_tokens` call in `recoverableCall`; builds delta from flags (input/output required, cache-read/cache-create default 0 when omitted); prints the server-returned `totalThisSession` JSON on stdout; on error prints and exits 1.
- [ ] 5.5 Create `src/client/deregister.ts` — `coordinator deregister` action. Does NOT contact the coordinator. Reads `--name` (or env), calls `deleteCache(name)`, exits 0 silently (even if no cache existed).
- [ ] 5.6 Register the five subcommands on the Commander program in `src/index.ts` with the flag schemas from the spec and short descriptions. Each subcommand action imports from `src/client/*` and invokes the implementation.
- [ ] 5.7 Unit tests per subcommand in `tests/client-subcommands.test.ts` (mocking the MCP client): register happy path writes cache and prints token; register quiet suppresses stdout; send JSON-body parses to object; send plain-text-body passes through as string; read wraps-for-prompt correctly; read default emits JSON array; report-tokens constructs delta with defaults; deregister unlinks cache; every authenticated subcommand invokes recovery on stale token.

## 6. Integration tests (subprocess-based)

- [ ] 6.1 Create `tests/client-cli-integration.test.ts`. Each test spawns a coordinator via the `serve` subcommand in a tmp `sessions-dir`, then invokes client subcommands as child processes. Pattern mirrors `tests/serve-mode.test.ts`.
- [ ] 6.2 Scenario: register + send + read round-trip. Coordinator up; `coordinator register --name a` in subprocess; `coordinator register --name b` in subprocess; `coordinator send --name a --to b --kind chat --body hello` in subprocess; `coordinator read --name b` in subprocess; assert one wrapped envelope returned; second read returns empty array.
- [ ] 6.3 Scenario: stale-token recovery. Register; manually corrupt the cache file by overwriting `sessionToken`; invoke `send` — assert it succeeds (recovery kicks in transparently).
- [ ] 6.4 Scenario: operator-intervention required. Register `name=a`; out-of-band, overwrite `a`'s cache with a stale token AND have a second process legitimately register as `a`; invoke `send` from the stale-cache process — assert exit 1 with operator-intervention stderr.
- [ ] 6.5 Scenario: `report-tokens` round-trip. Register; `coordinator report-tokens --input 100 --output 20 --model claude-opus-4-7`; assert server's `metrics.jsonl` contains one line with the delta; assert the `totalThisSession` in stdout is `{input:100,output:20,cacheRead:0,cacheCreate:0}`.
- [ ] 6.6 Scenario: `--wrap-for-prompt` output shape. Register a and b; send a chat from a to b; `coordinator read --name b --wrap-for-prompt`; assert stdout starts with `<peer-inbox>` and ends with `</peer-inbox>`; empty mailbox produces empty stdout.
- [ ] 6.7 Scenario: `report_tokens` not registered when `peerBus.metrics.enabled: false`. Start coordinator with metrics disabled; invoke `coordinator report-tokens`; assert it fails with an SDK unknown-tool error.
- [ ] 6.8 Scenario: aggregates survive restart. Register + report-tokens a few times; SIGTERM coordinator; restart; invoke `report-tokens` again; assert the returned `totalThisSession` includes the pre-restart deltas.

## 7. Documentation

- [ ] 7.1 README: add a new top-level "Integration guide" section. Walk through: install/link `coordinator`; set `COORDINATOR_URL` / `COORDINATOR_SESSION_NAME` / `COORDINATOR_AUTH_TOKEN`; call `coordinator register` once in the launcher; invoke `send` / `read` / `report-tokens` from the consumer's hook or script. Provide a worked Claude Code hook example AND a generic bash script example. Explicitly document the token cache file location precedence.
- [ ] 7.2 README: update the "Peer session bus" section to cross-reference the Integration guide; clarify that the MCP tools are still directly callable (for MCP Inspector, etc.) but the CLI is the recommended consumer path.
- [ ] 7.3 README: document the `peerBus.metrics` config block with its defaults and the opt-out.
- [ ] 7.4 CLAUDE.md: add a "Client subcommands" block mirroring the existing "Peer session bus" block — execFile-only anywhere we shell out, token-cache file permissions 0o600, aggregates not persisted to disk.
- [ ] 7.5 `docs/architecture.md` (if present, otherwise a new `docs/client-cli.md`): document the dual-role nature of the coordinator binary with a data-flow diagram showing consumer → CLI → token cache → HTTP MCP client → server tools → metrics.jsonl.

## 8. Manual verification

- [ ] 8.1 From a clean state, start `coordinator serve` in a tmux pane with `peerBus.enabled: true, peerBus.metrics.enabled: true`.
- [ ] 8.2 In a different tmux pane: `COORDINATOR_SESSION_NAME=main coordinator register`. Confirm cache file appears under `$TMPDIR/coordinator/main.token` with mode 0o600.
- [ ] 8.3 In a third pane: `COORDINATOR_SESSION_NAME=frontend coordinator register`. Send a chat from main to frontend: `COORDINATOR_SESSION_NAME=main coordinator send --to frontend --kind chat --body "hi there"`.
- [ ] 8.4 From frontend: `COORDINATOR_SESSION_NAME=frontend coordinator read --wrap-for-prompt`. Confirm the message arrives in a `<peer-inbox>` block.
- [ ] 8.5 From frontend: `COORDINATOR_SESSION_NAME=frontend coordinator report-tokens --input 12000 --output 2000 --cache-read 80000 --model claude-opus-4-7`. Confirm stdout shows the totals and `tail -f sessions/<id>/metrics.jsonl` shows the appended line.
- [ ] 8.6 Kill `coordinator serve`; restart it; `COORDINATOR_SESSION_NAME=frontend coordinator read` from frontend — confirm the recovery protocol kicks in transparently (stale token gets rotated; a new register_session succeeds because the server wiped tokenHash on restart). No user-visible failure.
- [ ] 8.7 `COORDINATOR_SESSION_NAME=frontend coordinator deregister`. Confirm cache file gone.
- [ ] 8.8 Run `npm run build && npm test` — all tests pass including the new client suites.
