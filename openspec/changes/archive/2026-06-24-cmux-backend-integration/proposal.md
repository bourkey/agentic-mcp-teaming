## Why

The peer bus teaming features (notifier, auto-wake) are tmux-only. Users running cmux as their terminal have no working notifier, broken auto-wake, and surface-addressing that fails because cmux uses `surface:N` IDs rather than tmux session names. Adding cmux as a parallel backend unblocks the full teaming stack for cmux users while keeping the existing tmux path untouched.

## What Changes

- **New `CmuxWakeBackend`** implementing the existing `WakeBackend` interface. `isPaneStateSafe()` is permanently disabled (`safe: false`, sentinel `<probe_disabled>`) until cmux exposes a `pane_current_command` equivalent (upstream issues #152/#153). `sendKeys()` uses `cmux send-surface` + `cmux send-key-surface enter`.
- **New `notifier-cmux.ts`** — `cmux notify --title --body` for inbox messages; `cmux set_status` / `clear_status` for sidebar badge (replaces tmux `window-status-style` tab colouring).
- **Config union** — `peerBus.backend: "tmux" | "cmux"` selects the active backend. All existing tmux config fields are preserved unchanged. New `peerBus.notifier.cmuxEnabled: boolean` field added.
- **Surface-ID registry** — session registry entries gain a `cmuxSurfaceId` field storing the `CMUX_SURFACE_ID` env var value reported at registration. The wake dispatcher uses this to target the correct cmux surface.
- **`register_session` tool** — accepts an optional `surfaceId` parameter; stored in the registry entry.
- **Target validation** — `SESSION_NAME_REGEX` rejects cmux IDs (`surface:7` contains `:`). Validation is moved into each backend so tmux and cmux can apply their own format rules.
- **`peer-bus-session` skill** — detects cmux context via `$CMUX_SURFACE_ID` / `$CMUX_SOCKET_PATH`; passes `surfaceId: $CMUX_SURFACE_ID` to `register_session`. Pane identity (`COORDINATOR_SESSION_NAME`) is resolved from a cmux workspace/pane name env var (spike task to identify the right variable).
- **Docs** — `peer-bus-runbook.md` and `README.md` updated with cmux launcher recipes.

## Capabilities

### New Capabilities

- `cmux-notifier`: Peer-bus notifier implementation for cmux — delivers inbox notifications via `cmux notify` and sets sidebar badge state via `cmux set_status`/`clear_status`.
- `cmux-wake-backend`: Auto-wake backend for cmux surfaces — probes pane safety (permanently disabled pending upstream fix) and delivers keystrokes via `cmux send-surface` / `cmux send-key-surface`.

### Modified Capabilities

- `peer-session-bus`: Session registration gains an optional `surfaceId` field; registry entries store `cmuxSurfaceId`; backend selection (`"tmux" | "cmux"`) is added to config; target validation moves into each backend.

## Impact

- **`src/core/wake-backends/`** — new `cmux.ts`; existing `tmux.ts` unchanged
- **`src/core/notifier-cmux.ts`** — new file; `notifier-tmux.ts` unchanged
- **`src/config.ts`** — new `backend` union field, new `cmuxEnabled` notifier field
- **`src/core/peer-bus-constants.ts`** — `SESSION_NAME_REGEX` may be narrowed to tmux-only; new `CMUX_SURFACE_ID_REGEX` added
- **`src/core/session-registry.ts`** — `cmuxSurfaceId` field added to entry type
- **`src/server/tools/peer-bus.ts`** — `register_session` accepts `surfaceId`; notifier/wake dispatch branched on `backend`
- **`src/server/index.ts`** — backend instantiation branched on config
- **`.claude/skills/peer-bus-session/SKILL.md`** — cmux env var detection and `surfaceId` registration
- **`docs/peer-bus-runbook.md`**, **`README.md`** — cmux recipes added
- **`tests/`** — new `wake-backend-cmux.test.ts`, `notifier-cmux.test.ts`; no changes to existing tests
- **External dependency** — `cmux` CLI binary must be on `PATH` in cmux panes (it is, automatically)
