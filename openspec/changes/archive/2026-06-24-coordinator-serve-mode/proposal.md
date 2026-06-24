## Why

The recently-merged `peer-session-bus` change added three MCP tools so long-lived Claude Code sessions can register with the coordinator and exchange workflow events. But the coordinator's lifecycle in [src/index.ts](../../../src/index.ts#L205-L241) is still bound to the phase-based consensus workflow: it starts the HTTP server, runs `proposal → design → spec → task → implementation`, then `stopServer()` in the `finally` block shuts the HTTP server down. For the tmux-based opsx workflow that motivated the bus in the first place, this is backwards — the coordinator needs to outlive individual changes so tmux panes stay connected across days of opsx work. A scoping gap in the `peer-session-bus` proposal: the bus requirements never stated "the coordinator SHALL remain running while peer sessions are connected," so the lifecycle story never got pinned down. This change closes that gap by adding a `serve` subcommand that starts the coordinator with peer-bus enabled and blocks on signals until terminated, without running workflow phases.

## What Changes

- **New CLI subcommand**: `npm start -- serve` (alongside the existing `start` and `status` subcommands). Options: `--config <path>` (default `mcp-config.json`), `--sessions-dir <path>` (default `./sessions`), `--session <id>` (optional; resume an existing coordinator session rather than creating a new one).
- **Behaviour**: `serve` loads config, creates or resumes a `SessionManager`, acquires `coordinator.lock`, initialises peer-bus persistence (registry.json, messages.jsonl), reconciles any unread ids, starts the HTTP server, and blocks on `SIGINT`/`SIGTERM`. No workflow phases run. No `--openspec-dir` required. No agent CLI validation at startup (agents are only invoked via the phase-driven workflow, which `serve` does not run).
- **Precondition**: `serve` requires `peerBus.enabled: true` in the config. Without it, the subcommand errors out immediately with a clear message — serve mode exists specifically to host the peer bus; without it, the command has nothing to do.
- **Clean shutdown**: the existing `registerLockCleanupHandlers` handles `SIGINT`/`SIGTERM`/`exit`/`uncaughtException`/`unhandledRejection` already. `serve` adds an additional shutdown step to call `stopServer()` before the lock release runs, so the HTTP server closes cleanly on signal.
- **Session state under serve mode**: the `SessionManager` session created by `serve` is durable just like a phase-driven session — `state.json`, `audit.log`, `snapshots/` are unchanged. The difference is that `currentPhase` never advances past its initial value because no phase runs. This is acceptable: `serve` sessions are bus-only and don't participate in consensus.
- **No change to the existing `start` subcommand.** Phase-driven workflows continue to work exactly as before; they can enable the peer bus alongside phases if desired, but the bus will die with the workflow as it does today.
- **Config clarification**: document in the README that `serve` is the normal way to run the coordinator for opsx-style tmux teaming, and `start` is for one-shot phase-driven workflows.

## Capabilities

### Modified Capabilities
- `mcp-integration`: adds a new CLI entry point (`serve`) and formalises the coordinator's lifecycle contract under peer-bus operation (the HTTP server and peer-bus persistence SHALL outlive any single workflow and terminate only on signal or fatal error).
- `peer-session-bus`: adds a requirement that the coordinator lifecycle is independent of the consensus workflow when peer-bus is enabled, and documents serve mode as the primary operational shape.

## Impact

- **New code**: ~30 lines in [src/index.ts](../../../src/index.ts) adding the `serve` subcommand. No new modules.
- **Reused code**: lock acquisition, registry/store initialisation, reconciliation, HTTP server startup — all already exist from `peer-session-bus` and are just re-invoked in a different control flow.
- **Tests**: a small integration test that starts `serve`, connects an MCP client, performs `register_session` + `send_message` + `read_messages`, confirms the server stays up past what a phase-driven workflow would take, then sends SIGTERM and asserts clean shutdown (lock file removed, session state persisted).
- **Docs**: update [README.md](../../../readme.md) with a "Running the coordinator for tmux teaming" section pointing at `serve`. Update [CLAUDE.md](../../../CLAUDE.md) with a note that `serve` is the default operational mode when the peer bus is in use.
- **Out of scope** (explicitly deferred): systemd/launchd unit files for auto-restart; log rotation; a health endpoint; a graceful-shutdown drain that waits for in-flight sends before closing. These are operational concerns best addressed once the bus is actually in production use.

## Why this is a real spec gap, not a nice-to-have

Without this change, the only way to keep the coordinator alive for peer-bus clients is to run `start --workflow proposal --dry-run` against a fake openspec change — an ergonomic anti-pattern and a direct contradiction of the v1 scope narrative (we cut scope to ship a minimum viable bus; we should not require workarounds to actually use it). The spec gap was mine: I should have written "coordinator SHALL remain running while peer-bus is enabled, independent of phase lifecycle" as a spec requirement in round 2 and let the design decision fall out from there.
