## ADDED Requirements

### Requirement: `register_session` accepts optional `surfaceId` and `workspaceId` parameters with three-value semantics

The `register_session` MCP tool SHALL accept two optional cmux parameters, both following three-value semantics (matching the existing `autoWakeKey` pattern):

**`surfaceId`** — stored as `cmuxSurfaceId`:
- `undefined` (absent) — preserve existing value; do NOT clear it. Ensures recovery re-registrations don't wipe the stored surface ID.
- `null` — explicitly clear `cmuxSurfaceId`.
- `string` — validate (non-empty after trim, matches `CMUX_SURFACE_ID_REGEX` `/^surface:\d+$/`, max 64 bytes) and store. Invalid returns error code `invalid_surface_id`. `mapRegisterZodError` SHALL map the `surfaceId` field path to `"invalid_surface_id"`.

**`workspaceId`** — stored as `cmuxWorkspaceId`:
- Same three-value semantics as `surfaceId`.
- Validated against `CMUX_WORKSPACE_ID_REGEX` (`/^workspace:\d+$/`), max 64 bytes. Invalid returns error code `invalid_workspace_id`. `mapRegisterZodError` SHALL map the `workspaceId` field path to `"invalid_workspace_id"`.
- `cmuxWorkspaceId` is required for badge management (`cmux set-status`/`clear-status` target a workspace, not a surface). The skill MUST pass `workspaceId: $CMUX_WORKSPACE_ID` alongside `surfaceId: $CMUX_SURFACE_ID`.

When a string value is provided for either field, the registry SHALL ALWAYS overwrite the stored value — never preserved from prior registration. This prevents stale IDs from persisting after a pane reopens.

The success response shape is unchanged: `{ name, sessionToken, registeredAt }`. The caller already has `cmuxSurfaceId` from the environment; it is not echoed back.

#### Scenario: Registration with surfaceId stores it in the registry
- **WHEN** `register_session({ name: "claude-main", surfaceId: "surface:3" })` is called
- **THEN** the registry entry for `"claude-main"` SHALL have `cmuxSurfaceId: "surface:3"`

#### Scenario: Registration without surfaceId preserves existing cmuxSurfaceId
- **WHEN** `register_session({ name: "claude-main" })` is called with no `surfaceId` field AND the entry already has `cmuxSurfaceId: "surface:3"`
- **THEN** the registry entry SHALL retain `cmuxSurfaceId: "surface:3"`; the field SHALL NOT be cleared

#### Scenario: Registration with null surfaceId clears cmuxSurfaceId
- **WHEN** `register_session({ name: "claude-main", surfaceId: null })` is called
- **THEN** the registry entry SHALL have no `cmuxSurfaceId` field

#### Scenario: Invalid surfaceId format returns error
- **WHEN** `register_session({ name: "claude-main", surfaceId: "not-a-surface-id" })` is called
- **THEN** `register_session` SHALL return error code `invalid_surface_id`; no registry entry SHALL be updated

#### Scenario: Re-registration always overwrites cmuxSurfaceId with new value
- **WHEN** an entry has `cmuxSurfaceId: "surface:3"` and `register_session({ name: "claude-main", surfaceId: "surface:7" })` is called
- **THEN** the registry entry SHALL have `cmuxSurfaceId: "surface:7"`; the old value SHALL NOT be preserved

### Requirement: `cmuxSurfaceId` is validated on `load()` and cleared if malformed

During `SessionRegistry.load()`, any persisted `cmuxSurfaceId` value that does not match `CMUX_SURFACE_ID_REGEX` (`/^surface:\d+$/`) SHALL be dropped from the loaded entry and a `warn` SHALL be emitted naming the affected session name and the invalid value. The entry SHALL otherwise be retained. Valid `cmuxSurfaceId` values are preserved across restarts. This guards against tampered `registry.json` files passing malformed surface IDs into `execFile` argv.

#### Scenario: Valid cmuxSurfaceId survives load
- **WHEN** `registry.json` contains an entry with `cmuxSurfaceId: "surface:5"`
- **THEN** the loaded entry SHALL retain `cmuxSurfaceId: "surface:5"`; no warn SHALL be emitted

#### Scenario: Malformed cmuxSurfaceId is dropped on load with warn
- **WHEN** `registry.json` contains an entry with `cmuxSurfaceId: "--evil-flag"` (fails CMUX_SURFACE_ID_REGEX)
- **THEN** the loaded entry SHALL NOT have `cmuxSurfaceId` set; a `warn` SHALL be emitted naming the session and the invalid value

#### Scenario: Absent cmuxSurfaceId loads successfully
- **WHEN** `registry.json` contains an entry with no `cmuxSurfaceId` field (e.g. written by pre-cmux coordinator)
- **THEN** the entry SHALL load successfully with `cmuxSurfaceId` unset; no warn SHALL be emitted

### Requirement: `SessionRegistryEntry` gains a `wakeTarget` field for backend-agnostic target resolution

`SessionRegistryEntry` SHALL gain an optional `wakeTarget?: string` field. The wake dispatcher SHALL always pass `entry.wakeTarget ?? entry.name` as the `target` argument to `backend.sendKeys(target, resolvedCommand)`. This decouples the dispatcher from backend-specific target formats:

- For tmux recipients (no `cmuxSurfaceId`): `wakeTarget` is absent; dispatcher passes `entry.name` (tmux session name).
- For cmux recipients: `wakeTarget` is set to `entry.cmuxSurfaceId` when `cmuxSurfaceId` is stored. The coordinator SHALL update `entry.wakeTarget = entry.cmuxSurfaceId` whenever `cmuxSurfaceId` is written.

`wakeTarget` SHALL NOT be persisted to `registry.json`; it is recomputed from `cmuxSurfaceId` at registration time and during `load()` (for entries with a valid `cmuxSurfaceId`).

#### Scenario: cmux recipient dispatcher uses cmuxSurfaceId as target
- **WHEN** the wake dispatcher processes a recipient with `cmuxSurfaceId: "surface:3"` and `name: "claude-main"`
- **THEN** the dispatcher SHALL call `backend.sendKeys("surface:3", resolvedCommand)`, NOT `backend.sendKeys("claude-main", resolvedCommand)`

#### Scenario: tmux recipient dispatcher uses session name as target
- **WHEN** the wake dispatcher processes a recipient with no `cmuxSurfaceId` and `name: "claude-main"`
- **THEN** the dispatcher SHALL call `backend.sendKeys("claude-main", resolvedCommand)`

### Requirement: Config gains `peerBus.backend` union field selecting the active backend

`mcp-config.json` SHALL accept a new `peerBus.backend` field with value `"tmux"` or `"cmux"`, defaulting to `"tmux"` when absent. The coordinator SHALL instantiate the matching `WakeBackend` implementation and notifier at startup based on this field. The `peerBus.notifier` block is extended with `cmuxEnabled: boolean` (default `false`) parallel to the existing `tmuxEnabled`. All existing `peerBus.notifier.tmuxEnabled`, `displayMessageFormat`, and `unreadTabStyle` fields are preserved unchanged.

Note: the combination of `backend` and `cmuxEnabled` governs both subsystems. See design.md D2 for the full combination table and rationale.

#### Scenario: Absent `backend` field defaults to tmux
- **WHEN** `mcp-config.json` has no `peerBus.backend` field
- **THEN** the coordinator SHALL behave identically to the pre-change behaviour, using `TmuxWakeBackend` and the tmux notifier

#### Scenario: `backend: "cmux"` selects cmux implementations
- **WHEN** `peerBus.backend: "cmux"` is set in config
- **THEN** the coordinator SHALL use `CmuxWakeBackend` and `notifier-cmux.ts`; it SHALL NOT invoke any `tmux` binary

#### Scenario: `backend: "tmux"` with `cmuxEnabled: true` is valid config
- **WHEN** `peerBus.backend: "tmux"` and `peerBus.notifier.cmuxEnabled: true` are both set
- **THEN** the config SHALL parse successfully; the coordinator SHALL use the tmux backend; the `cmuxEnabled` field has no effect unless `backend: "cmux"` is active

### Requirement: `wake_suppressed` reason union includes `"probe_disabled"`; `WakeBackend.isPaneStateSafe` gains optional `suppressReason` field

The `WakeBackend.isPaneStateSafe(target)` return type SHALL gain an optional `suppressReason?: "probe_disabled" | "pane_state_unsafe"` field. When `safe: false`, the dispatcher SHALL use `suppressReason` if present to determine the audit reason; if absent the dispatcher falls back to `"pane_state_unsafe"`. The constant `PROBE_DISABLED_SENTINEL = "<probe_disabled>"` SHALL be defined in `peer-bus-constants.ts`.

The `reason` field of `wake_suppressed` audit entries SHALL be one of `"debounce" | "pane_state_unsafe" | "key_no_longer_in_allowlist" | "probe_disabled"`. `"probe_disabled"` is emitted when the backend's `isPaneStateSafe` returns `suppressReason: "probe_disabled"` — exclusively for backends whose safety probe is disabled (currently `CmuxWakeBackend`). Operators can distinguish a genuinely unsafe pane (`pane_state_unsafe`) from a disabled probe (`probe_disabled`) in the audit log.

#### Scenario: cmux backend suppression uses reason `probe_disabled`
- **WHEN** the wake dispatcher invokes `CmuxWakeBackend.isPaneStateSafe` for a cmux recipient
- **THEN** the returned value SHALL have `suppressReason: "probe_disabled"` AND the dispatcher SHALL emit `wake_suppressed { reason: "probe_disabled" }`, NOT `{ reason: "pane_state_unsafe" }`

#### Scenario: tmux backend still uses reason `pane_state_unsafe`
- **WHEN** `TmuxWakeBackend.isPaneStateSafe` returns `{ safe: false }` for a non-allowlisted command (no `suppressReason` set)
- **THEN** the dispatcher SHALL emit `wake_suppressed { reason: "pane_state_unsafe" }` as before

#### Scenario: Backends without `suppressReason` default to `pane_state_unsafe`
- **WHEN** `isPaneStateSafe` returns `{ safe: false, currentCommand: "sudo" }` with no `suppressReason` field
- **THEN** the dispatcher SHALL emit `wake_suppressed { reason: "pane_state_unsafe" }`

## MODIFIED Requirements

### Requirement: `TmuxWakeBackend.sendKeys` makes two literal-mode `execFile` calls with no shell interpolation

When the `wakeDispatcher` has resolved a recipient's `autoWakeKey` against the allowlist, determined the pane state is safe, and passed the debounce check, it SHALL invoke `TmuxWakeBackend.sendKeys(target, resolvedCommand)`. The backend SHALL make exactly two `execFile("tmux", [...])` calls in sequence, with arguments passed as arrays and no shell involved:

1. `execFile("tmux", ["send-keys", "-l", "-t", target, resolvedCommand])` — the literal-mode `-l` flag prevents tmux from reinterpreting characters in `resolvedCommand` as key bindings.
2. `execFile("tmux", ["send-keys", "-t", target, "Enter"])` — delivers the Enter keystroke as a key name.

`target` SHALL be validated against `SESSION_NAME_REGEX` from `peer-bus-constants.ts` (unchanged; `^[a-z0-9][a-z0-9-]{0,62}$`) before any `execFile` call. `TmuxWakeBackend` MAY additionally define a module-scoped `TMUX_TARGET_REGEX` alias pointing to the same pattern for clarity, but `SESSION_NAME_REGEX` in `peer-bus-constants.ts` SHALL NOT be renamed — it is the canonical session-name validator used by `SessionRegistry` and other modules. No field of the triggering `send_message` call SHALL appear in either `execFile` argv. The `resolvedCommand` SHALL come only from `peerBus.autoWake.allowedCommands[<registrant's autoWakeKey>]`. The `target` SHALL come only from `entry.wakeTarget ?? entry.name`.

#### Scenario: Recipient opted in receives exactly two tmux send-keys calls with expected argv
- **WHEN** a `send_message` call targets a recipient whose registration has `autoWakeKey: "claude-inbox"` AND `peerBus.autoWake.allowedCommands["claude-inbox"]` is `/opsx:peer-inbox` AND the pane-state safety gate passes AND no debounce suppression applies
- **THEN** the backend SHALL invoke `execFile("tmux", ["send-keys", "-l", "-t", "<target>", "/opsx:peer-inbox"])` AND subsequently `execFile("tmux", ["send-keys", "-t", "<target>", "Enter"])` with no shell interpolation

#### Scenario: Sender-controlled `send_message` body does not influence the argv
- **WHEN** a `send_message` call targeting a recipient with `autoWakeKey: "claude-inbox"` has a body field containing shell metacharacters (for example `"$(rm -rf /)"` or ``"`whoami`"``)
- **THEN** the `execFile` argv for the resulting wake dispatch SHALL be identical to the argv produced by a `send_message` call with an empty body; no substring of the body SHALL appear in any argument

#### Scenario: Target resolution matches the passive notifier
- **WHEN** a recipient is registered with a session-qualified target AND both the passive notifier and the wakeDispatcher fire
- **THEN** both the `set-window-option` and the two `send-keys` calls SHALL use the same `<target>` string derived from `entry.wakeTarget ?? entry.name`

#### Scenario: tmux-format target passes `SESSION_NAME_REGEX` validation
- **WHEN** `TmuxWakeBackend.sendKeys("claude-main", "/opsx:peer-inbox")` is called
- **THEN** `"claude-main"` SHALL pass `SESSION_NAME_REGEX` validation; two `execFile` calls SHALL proceed
