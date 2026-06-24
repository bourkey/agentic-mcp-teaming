# cmux-wake-backend Specification

## Purpose
TBD - created by archiving change cmux-backend-integration. Update Purpose after archive.
## Requirements
### Requirement: `CmuxWakeBackend.isPaneStateSafe` is permanently disabled pending upstream fix

`CmuxWakeBackend.isPaneStateSafe(target)` SHALL always return `{ safe: false, currentCommand: PROBE_DISABLED_SENTINEL, suppressReason: "probe_disabled" }` without making any external call. `PROBE_DISABLED_SENTINEL` is the constant `"<probe_disabled>"` defined in `peer-bus-constants.ts`. The `suppressReason: "probe_disabled"` field causes the dispatcher to emit `wake_suppressed { reason: "probe_disabled" }` (not `"pane_state_unsafe"`), making the disabled probe distinguishable from a genuinely unsafe pane in the audit log. This behaviour persists until cmux exposes a `pane_current_command` equivalent (upstream issues #152/#153), at which point the implementation can be replaced without interface changes.

#### Scenario: Safety probe always returns safe:false with suppressReason for cmux backend
- **WHEN** `CmuxWakeBackend.isPaneStateSafe` is called with any target string
- **THEN** it SHALL return `{ safe: false, currentCommand: "<probe_disabled>", suppressReason: "probe_disabled" }` without invoking `execFile` or any external process

#### Scenario: Auto-wake is suppressed with reason `probe_disabled` for cmux recipients
- **WHEN** a `send_message` targets a cmux recipient with a valid `autoWakeKey` and no debounce suppression applies
- **THEN** the wake dispatcher SHALL emit `wake_suppressed { reason: "probe_disabled" }` and SHALL NOT invoke `CmuxWakeBackend.sendKeys`

### Requirement: `CmuxWakeBackend.sendKeys` uses `cmux send-surface` and `cmux send-key-surface` with no shell interpolation; dispatcher resolves target from `entry.cmuxSurfaceId`

The wake dispatcher SHALL resolve the cmux wake target from `entry.cmuxSurfaceId` (stored in the registry at registration time) and pass it as the `target` argument via the `entry.wakeTarget` field (`entry.wakeTarget ?? entry.name`, where `wakeTarget` is set to `cmuxSurfaceId` for cmux recipients). `CmuxWakeBackend.sendKeys(target, resolvedCommand)` SHALL make exactly two `execFile` calls in sequence with arguments as arrays and no shell involved:

1. `execFile("cmux", ["send-surface", "--surface", target, resolvedCommand], { timeout: 5000 })` — delivers the resolved command text to the target surface.
2. `execFile("cmux", ["send-key-surface", "--surface", target, "enter"], { timeout: 5000 })` — delivers the Enter key press.

`target` SHALL be validated against `CMUX_SURFACE_ID_REGEX` (`/^surface:\d+$/`, defined as a module-scoped constant in `src/core/wake-backends/cmux.ts`) before any `execFile` call. An invalid target SHALL throw immediately without any `execFile` invocation. An empty or whitespace-only `resolvedCommand` SHALL throw immediately. The two-phase `failurePhase` contract from the `WakeBackend` interface (`"type"` vs `"enter"`) SHALL be preserved.

No field of the triggering `send_message` call SHALL appear in either `execFile` argv. `resolvedCommand` SHALL come only from `peerBus.autoWake.allowedCommands[<registrant's autoWakeKey>]`. `target` SHALL come only from the recipient's registered `cmuxSurfaceId` via `wakeTarget`.

Note: OQ2 (whether `cmux send-surface` delivers text literally or interprets key sequences) is tracked as an escalated open question. If cmux does NOT have a literal-mode flag equivalent to `tmux send-keys -l`, `scrubForCmux()` MUST be strengthened to strip key-name sequences before the `sendKeys` spec can be considered complete. See design.md OQ2.

#### Scenario: Valid target and command produce exactly two execFile calls with expected argv
- **WHEN** `sendKeys("surface:3", "/opsx:peer-inbox")` is called
- **THEN** `execFile("cmux", ["send-surface", "--surface", "surface:3", "/opsx:peer-inbox"])` SHALL be called first, followed by `execFile("cmux", ["send-key-surface", "--surface", "surface:3", "enter"])`, with no other `execFile` calls

#### Scenario: Invalid target format rejects without execFile invocation
- **WHEN** `sendKeys("claude-main", "/opsx:peer-inbox")` is called (tmux-format target passed to cmux backend)
- **THEN** the call SHALL throw with an error indicating invalid target; no `execFile` call SHALL be made

#### Scenario: Empty resolved command rejects without execFile invocation
- **WHEN** `sendKeys("surface:3", "  ")` is called
- **THEN** the call SHALL throw with an error indicating empty command; no `execFile` call SHALL be made

#### Scenario: First execFile failure sets failurePhase "type"
- **WHEN** the `cmux send-surface` call exits non-zero
- **THEN** `sendKeys` SHALL throw a `WakeBackendError` with `failurePhase: "type"`; the second `send-key-surface` call SHALL NOT be attempted

#### Scenario: Second execFile failure sets failurePhase "enter"
- **WHEN** the `cmux send-surface` call succeeds but the `cmux send-key-surface` call exits non-zero
- **THEN** `sendKeys` SHALL throw a `WakeBackendError` with `failurePhase: "enter"`; the resolved command was already delivered to the pane

### Requirement: cmux target validation uses module-scoped `CMUX_SURFACE_ID_REGEX`; `SESSION_NAME_REGEX` is NOT renamed

`CmuxWakeBackend` SHALL define a module-scoped `CMUX_SURFACE_ID_REGEX = /^surface:\d+$/` constant in `src/core/wake-backends/cmux.ts` and validate wake targets against it. `SESSION_NAME_REGEX` in `src/core/peer-bus-constants.ts` SHALL NOT be renamed — it is the canonical session-name validator used by `SessionRegistry`, `TmuxWakeBackend`, and other modules. `TmuxWakeBackend` MAY define a module-scoped alias `TMUX_TARGET_REGEX` pointing to the same pattern, but the canonical export remains `SESSION_NAME_REGEX`. The `WakeDispatcher` SHALL NOT perform target format validation itself — that is a backend concern, delegated via the `wakeTarget` field.

#### Scenario: cmux surface ID passes cmux backend validation
- **WHEN** `isPaneStateSafe("surface:7")` or `sendKeys("surface:7", ...)` is called
- **THEN** the target SHALL pass `CMUX_SURFACE_ID_REGEX` validation

#### Scenario: tmux-format target fails cmux backend validation
- **WHEN** `sendKeys("claude-main", ...)` is called on `CmuxWakeBackend`
- **THEN** the call SHALL throw immediately without invoking `execFile`

#### Scenario: SESSION_NAME_REGEX continues to be exported from peer-bus-constants.ts unchanged
- **WHEN** any module imports `SESSION_NAME_REGEX` from `peer-bus-constants.ts`
- **THEN** the import SHALL resolve to the existing `^[a-z0-9][a-z0-9-]{0,62}$` pattern; no rename or removal SHALL break existing importers

