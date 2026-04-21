## ADDED Requirements

### Requirement: Coordinator exposes a `serve` CLI subcommand for bus-only operation

The coordinator CLI SHALL expose a `serve` subcommand alongside the existing `start` and `status` subcommands. `serve` SHALL start the coordinator in bus-only mode: no workflow phases execute, no agent CLIs are validated, and the HTTP server outlives any single workflow. The subcommand SHALL accept `--config <path>` (default `mcp-config.json`), `--sessions-dir <path>` (default `./sessions`), and `--session <id>` (optional; resume a prior bus session). The subcommand SHALL require `peerBus.enabled: true` in the loaded config; if the peer bus is not enabled, the coordinator SHALL exit with a non-zero status and a clear error message.

#### Scenario: serve subcommand listed in CLI help
- **WHEN** the operator runs `npm start -- --help` (or equivalent)
- **THEN** the output SHALL list `serve` as an available subcommand alongside `start` and `status`, with a short description referencing peer-bus operation

#### Scenario: serve requires peerBus.enabled
- **WHEN** `npm start -- serve` is invoked and the loaded config has `peerBus.enabled` absent or set to false
- **THEN** the coordinator SHALL exit with a non-zero status and a stderr message naming `peerBus.enabled` as the missing precondition

#### Scenario: serve does not run phases
- **WHEN** `npm start -- serve` is invoked and the config has `peerBus.enabled: true`
- **THEN** the coordinator SHALL NOT invoke `runProposalPhase`, `runDesignPhase`, `runSpecsPhase`, `runTasksPhase`, or `ImplementationPhase`; no phase artifact path SHALL be read

#### Scenario: serve does not validate agent CLIs
- **WHEN** `serve` is invoked and the config's `agents` map contains an entry whose `cli` is not present in `PATH`
- **THEN** the coordinator SHALL start successfully anyway; agent CLI validation SHALL NOT run in serve mode

#### Scenario: serve respects --session for resume
- **WHEN** `serve --session <id>` is invoked and the `<id>` directory exists under `sessions-dir`
- **THEN** the coordinator SHALL load the existing session via `SessionManager.load`, reusing `state.json` and continuing with the prior `sessionId`

### Requirement: Serve-mode coordinator lifecycle outlives any single workflow

In `serve` mode, the coordinator HTTP server and peer-bus persistence SHALL remain running until the process receives a termination signal (`SIGINT` / `SIGTERM`). The server SHALL NOT shut down because any internal event (workflow completion, agent failure, audit log write error) has occurred — those events are not applicable in serve mode because no workflow runs.

On signal receipt, the coordinator SHALL: (a) call `stopServer()` to close the HTTP listening socket cleanly, (b) allow the existing lock-cleanup handlers from `peer-session-bus` (`registerLockCleanupHandlers`) to release `coordinator.lock` after verifying PID, and (c) exit with status 0.

#### Scenario: SIGINT triggers clean shutdown
- **WHEN** `serve` is running and the process receives `SIGINT`
- **THEN** the coordinator SHALL close the HTTP socket, release `coordinator.lock` after PID verification, and exit with status 0; `messages.jsonl` and `registry.json` SHALL remain on disk unchanged

#### Scenario: SIGTERM triggers clean shutdown
- **WHEN** `serve` is running and the process receives `SIGTERM`
- **THEN** the same sequence SHALL execute as for `SIGINT`

#### Scenario: Lock is released only if PID matches
- **WHEN** `serve` receives a termination signal but `coordinator.lock` no longer contains `pid=<this process's pid>` (a rare race where another process replaced it)
- **THEN** the lock SHALL NOT be unlinked; a warning SHALL be logged; the process still exits

#### Scenario: HTTP server is closed before process exit
- **WHEN** `serve` is shutting down
- **THEN** the `stopServer()` call SHALL complete before the lock-cleanup handlers return control to the runtime; no half-closed connections SHALL linger past process exit

### Requirement: Serve mode and start mode share peer-bus bootstrap logic

The bootstrap sequence that brings the peer bus online (acquire `coordinator.lock`, touch `messages.jsonl`, load `SessionRegistry` from `registry.json`, load `MessageStore`, run startup reconciliation, persist the reconciled registry, wire the registry+store into the MCP server) SHALL be factored into a single helper reused by both the `start` subcommand (when `peerBus.enabled: true`) and the `serve` subcommand. A change to one path SHALL automatically apply to the other — there is one source of truth for "bring the peer bus online."

#### Scenario: Start with peer bus enabled and serve behave identically on bus bootstrap
- **WHEN** both subcommands are invoked against identical `mcp-config.json` and `sessions-dir` configurations (empty `sessions/`)
- **THEN** the resulting `sessions/<coord-session>/coordinator.lock`, `registry.json`, and `messages.jsonl` SHALL be functionally identical (content may differ only in trivial fields like `registeredAt` timestamps); no subcommand-specific side effects SHALL occur in the bootstrap path

#### Scenario: Bootstrap reconciliation runs in both modes
- **WHEN** either subcommand starts with a pre-existing `registry.json` containing orphaned or misrouted unread ids
- **THEN** the same reconciliation logic SHALL drop the invalid ids and emit the same aggregate warning
