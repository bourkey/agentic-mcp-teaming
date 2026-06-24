## 1. Refactor peer-bus bootstrap into a shared helper

- [x] 1.1 Extract the peer-bus bootstrap block from [src/index.ts](../../../src/index.ts) (the code under `if (config.peerBus?.enabled === true) { ... }` from `mkdir(sessionDir, ...)` through `peerBusWiring = { registry, store, logger }`) into a new exported function `bootstrapPeerBus(sessionsDir: string, sessionId: string, logger: AuditLogger): Promise<{ wiring: PeerBusWiring; releaseLock: () => void; unregisterHandlers: () => void }>` in a new module `src/core/peer-bus-bootstrap.ts`. Update `src/index.ts` `start` subcommand to call the helper.
- [x] 1.2 Unit test in `tests/peer-bus-bootstrap.test.ts` using a tmp directory: helper acquires the lock, touches `messages.jsonl`, creates `registry.json`, returns a working `PeerBusWiring`; release function unlocks cleanly; a second call against the same dir throws `CoordinatorLockError`.
- [x] 1.3 Verify `npm test` still passes after the refactor (no behaviour change for the `start` path).

## 2. Add the `serve` CLI subcommand

- [x] 2.1 In `src/index.ts`, register a new `serve` subcommand on the Commander `program`: options `--config <path>` (default `mcp-config.json`), `--sessions-dir <path>` (default `./sessions`), `--session <id>` (optional resume).
- [x] 2.2 Implement the `serve` action: (a) load config via `loadConfig`; (b) if `config.peerBus?.enabled !== true`, print a clear error to stderr naming `peerBus.enabled` as the missing precondition and exit with code 1; (c) create or resume a `SessionManager` session; (d) build an `AuditLogger`; (e) call `bootstrapPeerBus(...)` to bring the bus online; (f) construct the coordinator server via `createCoordinatorServer` with `peerBus: wiring` but NO phase-related parameters (agents/registry/consensus/checkpoint are still needed because the server interface requires them — pass lightweight defaults or the existing registry without CLI validation); (g) call `startHttpServer`; (h) log `serve_started` to audit; (i) `await` a Promise that resolves only on SIGINT/SIGTERM (wire via `process.once('SIGINT', resolve); process.once('SIGTERM', resolve)`); (j) in `finally`, call `stopServer()`, then `unregisterHandlers()`, then `releaseLock()`; log `serve_stopped`.
- [x] 2.3 Skip agent CLI validation entirely in serve mode — do NOT call `validateRegistryClis`.
- [x] 2.4 Ensure signal handlers from `registerLockCleanupHandlers` do NOT double-handle alongside the `serve` action's own signal wait. Option: have `bootstrapPeerBus` return a signal-wait Promise OR have `serve` not register the global handlers itself and rely on the bootstrap's existing ones. Document the chosen approach in a code comment.

## 3. Tests

- [x] 3.1 `tests/serve-mode.test.ts`: programmatic test that constructs the CLI entry point for `serve` against a tmp `sessions-dir` and a config fixture with `peerBus.enabled: true`; waits for the HTTP server to be listening (probe `http://127.0.0.1:<port>/sse`); performs an MCP `register_session` call via an HTTP client; asserts a successful response; then sends `SIGTERM` to the child process; asserts exit code 0 and that `coordinator.lock` is removed.
- [x] 3.2 `tests/serve-mode.test.ts`: `serve` exits with code 1 and a stderr message referencing `peerBus.enabled` when the config has the peer bus disabled.
- [x] 3.3 `tests/serve-mode.test.ts`: `serve` starts successfully even when the config's `agents` map declares a CLI not present in `PATH` (use a bogus `cli: "definitely-not-installed"` in the fixture).
- [x] 3.4 `tests/serve-mode.test.ts`: `serve` with `--session <id>` against a pre-existing session directory resumes that session (verify by inspecting `state.json.sessionId` equals the passed id).
- [x] 3.5 `tests/peer-bus-bootstrap.test.ts` (from task 1.2): bootstrap is idempotent for a clean sessions-dir and lock-exclusive on repeat.
- [x] 3.6 Extend `tests/e2e.test.ts` or add a new integration test: verify that `start --workflow proposal` with `peerBus.enabled: true` still runs phases AND still shuts down the HTTP server on completion (backwards-compatibility assertion).

## 4. Documentation

- [x] 4.1 Update [readme.md](../../../readme.md): add a "Running the coordinator" section listing both `start` (phase-driven workflow, one-shot) and `serve` (bus-only, long-running). In the existing "Peer session bus" section, change the recommended command from `start` to `serve` and clarify that `start` will shut down on phase completion.
- [x] 4.2 Update [CLAUDE.md](../../../CLAUDE.md): add a line under "Peer session bus" stating that `serve` is the default operational mode when the peer bus is in use; `start` with peer-bus enabled is a valid but short-lived configuration.
- [x] 4.3 Update the CLI `--help` output for both subcommands to include a one-line pointer to the other: `start`'s help mentions "for bus-only operation see `serve`"; `serve`'s help mentions "for one-shot phase-driven workflow see `start`".

## 5. Manual verification

- [x] 5.1 Run `npm start -- serve --config mcp-config.json` locally with `peerBus.enabled: true`. Confirm the HTTP server binds, `coordinator.lock` appears, `messages.jsonl` and `registry.json` are created.
- [x] 5.2 In a second terminal, use `npx @modelcontextprotocol/inspector` (or `curl` against `/sse`) to connect and invoke `register_session`. Confirm a token is returned and the audit log records the call.
- [x] 5.3 Wait a few minutes. Confirm the server has NOT shut down and continues serving tools.
- [x] 5.4 `kill -TERM <pid>` the coordinator. Confirm clean shutdown: `coordinator.lock` removed, exit code 0, `audit.log` records `serve_stopped`.
- [x] 5.5 Re-run `serve` and confirm lock acquisition succeeds on a second run.
- [x] 5.6 Run `npm run build && npm test` — all tests pass including the new `serve`-mode tests.
