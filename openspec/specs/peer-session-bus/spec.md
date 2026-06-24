# Peer Session Bus Specification

## Purpose

Defines the peer session bus auto-wake subsystem: the `wakeDispatcher` module, literal-mode tmux send-keys, the pane-state safety gate, per-recipient debounce, persistence with revalidation, key-only audit events, and failure isolation from `send_message` callers.
## Requirements
### Requirement: Auto-wake is implemented by a dedicated `wakeDispatcher` module invoked alongside the passive notifier

The peer-bus SHALL fan out each `send_message` delivery to two independent downstream paths:

1. The existing passive window-bar decoration via `notifierTmux` — unchanged in this capability. Fires on every message regardless of auto-wake opt-in.
2. A new active `wakeDispatcher` — owns allowlist resolution, per-recipient debounce, pane-state safety gating, `wake_*` audit event emission, failure handling, and health counters. Fires only for recipients whose registration records an `autoWakeKey`.

The `wakeDispatcher` SHALL delegate the backend-specific operations (pane-state probe and `send-keys`) to a `WakeBackend` interface. The v1 coordinator SHALL ship exactly one `WakeBackend` implementation, `TmuxWakeBackend`, which uses `execFile` to invoke `tmux`. The `WakeBackend` interface SHALL be shaped to accommodate future non-tmux backends (zellij, kitty, screen) without requiring changes to the dispatcher.

A passive notifier failure (e.g. `set-window-option failed`) SHALL NOT prevent the wake dispatch from attempting; a wake dispatch failure SHALL NOT prevent the passive notifier from attempting. The two paths are independent.

#### Scenario: Fan-out on every `send_message`
- **WHEN** a `send_message` is delivered for a recipient whose registration has `autoWakeKey: "claude-inbox"`
- **THEN** both the passive `set-window-option` call and the wakeDispatcher path SHALL be invoked; neither path SHALL depend on the other's success

#### Scenario: Recipient without `autoWakeKey` triggers only the passive path
- **WHEN** a `send_message` is delivered for a recipient whose registration has no `autoWakeKey`
- **THEN** only the passive `set-window-option` call SHALL fire; the wakeDispatcher SHALL NOT invoke any `WakeBackend` method; no `wake_*` audit entries SHALL be emitted

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

### Requirement: Pane-state safety gate suppresses wake when the recipient pane is in a non-allowlisted command

Before invoking `TmuxWakeBackend.sendKeys`, the `wakeDispatcher` SHALL delegate a pane-state probe to `TmuxWakeBackend.isPaneStateSafe(target)`. The probe SHALL invoke `execFile("tmux", ["display-message", "-p", "-t", target, "#{pane_current_command}"])`, trim the result, and compare it (case-sensitive, exact match) against the operator-declared list `peerBus.autoWake.allowedPaneCommands`. If the trimmed pane-current-command is in the allowlist, the probe returns `{ safe: true, currentCommand: <value> }`; otherwise it returns `{ safe: false, currentCommand: <value> }`.

If the probe fails with a non-zero exit or a signal (tmux server unreachable, pane not found, etc.), the probe SHALL return `{ safe: false, currentCommand: "<probe_failed>" }` — the dispatcher SHALL treat probe failure as unsafe and suppress the dispatch.

When the probe returns `safe: false`, the `wakeDispatcher` SHALL emit a `wake_suppressed` audit entry with `reason: "pane_state_unsafe"` and SHALL NOT call `TmuxWakeBackend.sendKeys`. The debounce timestamp SHALL NOT be updated for a pane-state-unsafe suppression (an unsafe pane is a non-event from the debounce window's perspective).

#### Scenario: Allowlisted shell allows dispatch
- **WHEN** the pane-state probe for a recipient returns `{ safe: true, currentCommand: "bash" }` (or any value in `peerBus.autoWake.allowedPaneCommands`)
- **THEN** the wakeDispatcher SHALL proceed to invoke `TmuxWakeBackend.sendKeys` (subject to debounce)

#### Scenario: Non-allowlisted command suppresses dispatch
- **WHEN** the pane-state probe for a recipient returns `{ safe: false, currentCommand: "sudo" }` (or any value not in `allowedPaneCommands`)
- **THEN** the wakeDispatcher SHALL emit a `wake_suppressed { reason: "pane_state_unsafe" }` audit entry AND SHALL NOT invoke `TmuxWakeBackend.sendKeys`; no `send-keys` keystrokes SHALL be sent; the `lastWakeDispatchedAt` timestamp SHALL NOT be updated

#### Scenario: Probe failure is treated as unsafe
- **WHEN** the pane-state probe's `tmux display-message` call exits non-zero (or is killed by signal)
- **THEN** the wakeDispatcher SHALL treat the recipient as unsafe, emit `wake_suppressed { reason: "pane_state_unsafe" }`, and SHALL NOT invoke `TmuxWakeBackend.sendKeys`

### Requirement: Per-recipient debounce on `SessionRegistryEntry` with mutex-atomic check-and-set

The `wakeDispatcher` SHALL maintain per-recipient debounce state as an in-memory field `lastWakeDispatchedAt?: number` on `SessionRegistryEntry`, holding a unix-millisecond timestamp of the last dispatch ATTEMPT. The check-and-set of `lastWakeDispatchedAt` SHALL occur inside the session-registry per-entry mutex that already serialises `send_message` persistence for the recipient. The timestamp SHALL be written BEFORE the dispatcher invokes the (async) `TmuxWakeBackend.sendKeys`, so that a second concurrent invocation for the same recipient observing the same tick SHALL see the updated timestamp and suppress.

Both successful AND failed `sendKeys` dispatches SHALL update `lastWakeDispatchedAt` — a failed dispatch consumes the debounce window. Suppressions that never reached the `sendKeys` step (pane-state-unsafe, key-no-longer-in-allowlist) SHALL NOT update the timestamp.

`lastWakeDispatchedAt` SHALL NOT be persisted to `registry.json`. Coordinator restart resets the debounce window to "never dispatched"; the first message after restart dispatches immediately.

#### Scenario: Burst of messages produces one wake dispatch
- **WHEN** five `send_message` calls for recipient `main` arrive within 500 ms AND `debounceMs` is `1000` AND all other preconditions hold
- **THEN** exactly one `TmuxWakeBackend.sendKeys` dispatch SHALL occur; four `wake_suppressed { reason: "debounce" }` entries SHALL be emitted; five passive `set-window-option` calls SHALL fire independently

#### Scenario: Concurrent recipients do not block each other
- **WHEN** one `send_message` for recipient `main` and one `send_message` for recipient `backend` arrive within the same 100 ms window AND both recipients are opted in
- **THEN** both recipients SHALL receive their own wake dispatch; neither SHALL be suppressed by the other's dispatch

#### Scenario: Wake dispatches spaced beyond debounce window both fire
- **WHEN** two `send_message` calls for recipient `main` arrive 1500 ms apart AND `debounceMs` is `1000`
- **THEN** both calls SHALL produce a wake dispatch

#### Scenario: Same-tick concurrency does not produce duplicate dispatch
- **WHEN** two `send_message` calls for recipient `main` are processed in the same event-loop tick AND both observe the registry entry's `lastWakeDispatchedAt` before either writes
- **THEN** the mutex-atomic check-and-set SHALL ensure exactly one `TmuxWakeBackend.sendKeys` invocation fires; the second call SHALL observe the updated timestamp and emit `wake_suppressed { reason: "debounce" }`

#### Scenario: Failed dispatch still consumes the debounce window
- **WHEN** a wake dispatch for `main` fails (backend throws) AND a second `send_message` for `main` arrives 200 ms later AND `debounceMs` is `1000`
- **THEN** no second `TmuxWakeBackend.sendKeys` invocation SHALL occur; the second message SHALL emit `wake_suppressed { reason: "debounce" }`

#### Scenario: Debounce resets across coordinator restart
- **WHEN** the coordinator is stopped and restarted AND a `send_message` for recipient `main` arrives immediately after startup
- **THEN** the wake dispatch SHALL fire without debounce suppression; restart SHALL clear `lastWakeDispatchedAt` for every recipient

### Requirement: `SessionRegistryEntry.autoWakeKey` persists across restart with revalidation on load

`SessionRegistryEntry` SHALL gain an optional `autoWakeKey?: string` field persisted to `registry.json`. On `SessionRegistry.load`, each entry's stored `autoWakeKey` SHALL be revalidated against the currently-loaded `peerBus.autoWake.allowedCommands`:

- If the key is present in `allowedCommands`, the entry SHALL keep the field.
- If the key is absent from `allowedCommands` (whether because the operator removed it or because the entire `peerBus.autoWake` block was removed), the entry's `autoWakeKey` field SHALL be cleared in the loaded in-memory registry; a startup `warn` SHALL be logged naming the affected session name and the removed key. The on-disk `registry.json` MAY be rewritten with the cleared field (implementer's choice; either approach satisfies the spec).

Entries loaded from a `registry.json` written by a pre-change coordinator (no `autoWakeKey` field present at all) SHALL load successfully and behave as opt-out; no back-fill with defaults SHALL occur.

#### Scenario: Persisted key still in allowlist is kept across restart
- **WHEN** the coordinator is restarted with an unchanged config AND `registry.json` contains an entry with `autoWakeKey: "claude-inbox"` AND `claude-inbox` is still in `peerBus.autoWake.allowedCommands`
- **THEN** the loaded registry entry SHALL retain `autoWakeKey: "claude-inbox"`; no warn SHALL be logged for this entry

#### Scenario: Persisted key removed from allowlist is cleared on load with a warn
- **WHEN** the coordinator is restarted AND `registry.json` contains an entry with `autoWakeKey: "removed-key"` AND `removed-key` is no longer present in `peerBus.autoWake.allowedCommands`
- **THEN** the loaded registry entry SHALL NOT have `autoWakeKey` set; a startup `warn` SHALL be logged naming the session name and the removed key

#### Scenario: Pre-change registry.json loads without back-fill
- **WHEN** the coordinator loads a `registry.json` written before this change, with no `autoWakeKey` field on any entry
- **THEN** every entry SHALL load successfully and behave as opt-out; no `autoWakeKey` SHALL be back-filled from `defaultCommand` or any other source

### Requirement: `wake_*` audit event family captures dispatch, suppression, and failure with key-only identifiers

The `wakeDispatcher` SHALL emit entries in a closed `wake_*` audit-event family. No entry in this family SHALL contain the resolved command string, the `send-keys` argv, any subset of `mcp-config.json`, session tokens, or the session `tokenHash`. The `commandKey` is the only allowlist-linked identifier that ever lands in the audit log.

The family consists of:

- `wake_dispatched` — emitted once for every wake dispatch that actually invokes `TmuxWakeBackend.sendKeys`, whether the backend call succeeded or failed. Fields: `{ type: "wake_dispatched", target, commandKey, messageId, dispatchedAt, status, exitCode?, signal? }`. `status` is `"ok"` on success and `"failed"` on any backend error. `exitCode` and `signal` are populated on failure if available. `dispatchedAt` is a UTC ISO-8601 string ending in `Z`. Implementations MAY ADDITIONALLY emit a separate `wake_failed` entry on failure with the same field shape (convenient for grep ergonomics); this SHALL NOT replace the `wake_dispatched { status: "failed" }` entry.

- `wake_suppressed` — emitted when the dispatcher decided not to attempt a `sendKeys` call. Fields: `{ type: "wake_suppressed", target, commandKey, messageId, reason, suppressedAt }`. `reason` is one of `"debounce" | "pane_state_unsafe" | "key_no_longer_in_allowlist"`. The dispatcher MAY include a `currentCommand` field when `reason: "pane_state_unsafe"` for operator tuning.

Recipients that never opted in (no `autoWakeKey`) SHALL produce no `wake_*` audit entries on `send_message` delivery.

#### Scenario: Successful dispatch emits `wake_dispatched { status: "ok" }`
- **WHEN** a wake dispatch for recipient `main` with `commandKey: "claude-inbox"` completes successfully
- **THEN** the audit log SHALL contain a `wake_dispatched` entry with `target: "main"`, `commandKey: "claude-inbox"`, the originating `messageId`, a UTC `dispatchedAt` ending in `Z`, and `status: "ok"`; the entry SHALL NOT contain the resolved string `/opsx:peer-inbox`

#### Scenario: Failed dispatch emits `wake_dispatched { status: "failed" }` with exit information
- **WHEN** a wake dispatch for recipient `main` invokes `TmuxWakeBackend.sendKeys` and the backend throws because `send-keys` exited with code 1
- **THEN** the audit log SHALL contain a `wake_dispatched` entry with `status: "failed"` and `exitCode: 1`; the entry SHALL NOT contain the resolved command string

#### Scenario: Debounce suppression emits `wake_suppressed { reason: "debounce" }`
- **WHEN** a `send_message` for recipient `main` is suppressed because of the debounce window
- **THEN** the audit log SHALL contain a `wake_suppressed` entry with `reason: "debounce"`, no `wake_dispatched` entry SHALL be emitted for the suppressed event

#### Scenario: Pane-unsafe suppression emits `wake_suppressed { reason: "pane_state_unsafe" }`
- **WHEN** a `send_message` for recipient `main` is suppressed because the pane-state safety gate returned `safe: false`
- **THEN** the audit log SHALL contain a `wake_suppressed` entry with `reason: "pane_state_unsafe"`; no `send-keys` keystrokes SHALL be sent

#### Scenario: Missing allowlist entry at dispatch time emits `wake_suppressed { reason: "key_no_longer_in_allowlist" }`
- **WHEN** the `wakeDispatcher` attempts to resolve a recipient's stored `autoWakeKey` AND the key is not present in the live `peerBus.autoWake.allowedCommands` (e.g. because a rewritten `registry.json` has a stale key or a startup-revalidation race left a stale entry momentarily)
- **THEN** the audit log SHALL contain a `wake_suppressed` entry with `reason: "key_no_longer_in_allowlist"`; no `send-keys` keystrokes SHALL be sent

#### Scenario: Recipient without `autoWakeKey` produces no `wake_*` entries
- **WHEN** a `send_message` is delivered for a recipient whose registration has no `autoWakeKey`
- **THEN** no entry in the `wake_*` family SHALL be appended to the audit log for this delivery

#### Scenario: Audit entries never contain the resolved command string
- **WHEN** any entry in the `wake_*` family is appended to the audit log
- **THEN** the entry SHALL NOT contain the resolved command string from `peerBus.autoWake.allowedCommands[<commandKey>]`, the `send-keys` argv, any subset of `mcp-config.json`, session tokens, or the session `tokenHash`

### Requirement: Wake-dispatch failures do not propagate to `send_message` callers and do not retry

When `TmuxWakeBackend.sendKeys` fails (non-zero exit, killed by signal, target window absent, tmux server unreachable), the `wakeDispatcher` SHALL log a structured `warn` including only `{ target, commandKey, exitCode, signal }` — the warn entry SHALL NOT include the resolved command string, the `send-keys` argv, any subset of `mcp-config.json`, session tokens, or the session `tokenHash`. The dispatcher SHALL emit a `wake_dispatched { status: "failed" }` audit entry per the previous requirement. The dispatcher SHALL NOT retry the wake for the failed message.

Wake-dispatch failures SHALL NOT cause the triggering `send_message` call to fail: the caller SHALL receive a successful response regardless of wake outcome. Similarly, failure of the passive `set-window-option` call SHALL NOT cause `send_message` to fail.

#### Scenario: Backend failure surfaces as a warn and a failure-status audit entry, not a retry
- **WHEN** a wake dispatch for recipient `main` attempts `sendKeys` AND the backend throws with exit code 1 because no tmux window named `main` exists
- **THEN** the dispatcher SHALL log a `warn` naming `target`, `commandKey`, `exitCode`, `signal`; the audit log SHALL contain `wake_dispatched { status: "failed", exitCode: 1 }`; no retry SHALL be attempted for this message

#### Scenario: `send_message` returns success regardless of wake outcome
- **WHEN** `send_message` completes persistence AND the wake dispatch subsequently fails
- **THEN** `send_message` SHALL return a successful response to the caller; the failure SHALL be observable only via the warn log, the `wake_dispatched { status: "failed" }` audit entry, and the failure counter

#### Scenario: `send_message` returns success when passive notifier fails
- **WHEN** `send_message` completes persistence AND the passive `set-window-option` call fails
- **THEN** `send_message` SHALL return a successful response to the caller; the failure SHALL NOT propagate up the call stack

### Requirement: Auto-wake exposes per-recipient health counters

The `wakeDispatcher` SHALL maintain three per-recipient in-memory counters on the `SessionRegistryEntry`:

- `wakesDispatched: number` — count of `wake_dispatched { status: "ok" }` events for this recipient.
- `wakesSuppressed: number` — count of `wake_suppressed` events for this recipient across all reasons.
- `wakesFailed: number` — count of `wake_dispatched { status: "failed" }` events for this recipient.

These counters SHALL be readable through the same audit-log aggregation read path that today surfaces `lastSeenAt` for sessions. They SHALL NOT be persisted to `registry.json`; restart resets them to zero.

#### Scenario: Successful dispatch increments `wakesDispatched`
- **WHEN** a wake dispatch for recipient `main` succeeds
- **THEN** the registry entry's `wakesDispatched` counter for `main` SHALL increment by exactly 1

#### Scenario: Debounce suppression increments `wakesSuppressed`
- **WHEN** a wake dispatch for recipient `main` is suppressed by debounce
- **THEN** the registry entry's `wakesSuppressed` counter for `main` SHALL increment by exactly 1; `wakesDispatched` and `wakesFailed` SHALL NOT change

#### Scenario: Backend failure increments `wakesFailed`
- **WHEN** a wake dispatch for recipient `main` attempts `sendKeys` AND the backend throws
- **THEN** the registry entry's `wakesFailed` counter for `main` SHALL increment by exactly 1

#### Scenario: Counters reset across restart
- **WHEN** the coordinator restarts
- **THEN** every registry entry's `wakesDispatched`, `wakesSuppressed`, and `wakesFailed` counters SHALL be zero

### Requirement: Peer-bus coordinator lifecycle is independent of phase workflow

When the peer bus is enabled, the coordinator's HTTP server and peer-bus persistence SHALL remain available until the coordinator process receives a termination signal. The lifecycle SHALL NOT be tied to any single workflow execution; phase completion (`runProposalPhase`, `runDesignPhase`, `runSpecsPhase`, `runTasksPhase`, `ImplementationPhase` finishing) SHALL NOT cause the HTTP server to stop when the coordinator was started in `serve` mode.

The phase-driven `start` subcommand MAY still shut down the HTTP server when its workflow finishes — that is the defined shape for one-shot phase-driven runs. Operators running the peer bus for long-lived tmux teaming SHALL use the `serve` subcommand, which does not run phases at all.

#### Scenario: Serve keeps the HTTP server alive across days
- **WHEN** `serve` is running with `peerBus.enabled: true` and no signal has been received
- **THEN** the HTTP server SHALL continue accepting connections indefinitely; peer clients SHALL be able to `register_session`, `send_message`, and `read_messages` at any time while the process is alive

#### Scenario: Start mode shutdown behaviour unchanged
- **WHEN** `start` is invoked with `peerBus.enabled: true` and all workflow phases complete
- **THEN** the coordinator SHALL shut down the HTTP server after phase completion per the existing `finally { stopServer() }` pattern; peer sessions connected during the workflow SHALL lose their connections when the process exits. This is the documented, backwards-compatible behaviour for `start`.

#### Scenario: Serve is the recommended mode for tmux teaming
- **WHEN** the documented "Peer session bus" section of the README is followed to set up a tmux-based teaming workflow
- **THEN** the documented command SHALL be `npm start -- serve ...` (not `start`), and the README SHALL state explicitly that `start` is for phase-driven workflows and `serve` is for bus-only operation

### Requirement: Serve-mode session state is bus-only

A `SessionManager` session created or resumed by the `serve` subcommand SHALL have identical on-disk layout to a phase-driven session (`state.json`, `audit.log`, `snapshots/`, plus peer-bus files). The `currentPhase` field in `state.json` SHALL retain its initial value throughout the lifetime of a `serve` session because no phase runs. A `serve` session SHALL NOT be considered "complete" by any workflow criterion.

#### Scenario: Serve session currentPhase never advances
- **WHEN** a `serve` session runs for any duration
- **THEN** `state.json.currentPhase` SHALL equal its initial value at process exit

#### Scenario: Serve and start sessions are separate
- **WHEN** an operator runs `start --workflow proposal ...` while a `serve` coordinator is already running against the same `sessions-dir`
- **THEN** the second coordinator SHALL exit fatally because `coordinator.lock` is held; operators running both simultaneously SHALL use distinct `sessions-dir` values

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

