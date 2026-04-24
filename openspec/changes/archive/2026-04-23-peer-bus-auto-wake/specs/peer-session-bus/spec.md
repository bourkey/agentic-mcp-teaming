## ADDED Requirements

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

No field of the triggering `send_message` call (body, kind, replyTo, metadata, messageId, sender session name, sender tokenHash, HTTP headers) SHALL appear in either `execFile` argv. The `resolvedCommand` SHALL come only from `peerBus.autoWake.allowedCommands[<registrant's autoWakeKey>]`. The `target` SHALL come only from the recipient's registered session name, matching the same target-resolution rule the existing passive `notifier-tmux.set-window-option` call uses today.

#### Scenario: Recipient opted in receives exactly two tmux send-keys calls with expected argv
- **WHEN** a `send_message` call targets a recipient whose registration has `autoWakeKey: "claude-inbox"` AND `peerBus.autoWake.allowedCommands["claude-inbox"]` is `/opsx:peer-inbox` AND the pane-state safety gate passes AND no debounce suppression applies
- **THEN** the backend SHALL invoke `execFile("tmux", ["send-keys", "-l", "-t", "<target>", "/opsx:peer-inbox"])` AND subsequently `execFile("tmux", ["send-keys", "-t", "<target>", "Enter"])` with no shell interpolation

#### Scenario: Sender-controlled `send_message` body does not influence the argv
- **WHEN** a `send_message` call targeting a recipient with `autoWakeKey: "claude-inbox"` has a body field containing shell metacharacters (for example `"$(rm -rf /)"` or ``"`whoami`"``)
- **THEN** the `execFile` argv for the resulting wake dispatch SHALL be identical to the argv produced by a `send_message` call with an empty body; no substring of the body SHALL appear in any argument

#### Scenario: Target resolution matches the passive notifier
- **WHEN** a recipient is registered with a session-qualified target (e.g. `sessionName:windowName`) AND both the passive notifier and the wakeDispatcher fire
- **THEN** both the `set-window-option` and the two `send-keys` calls SHALL use the same `<target>` string; auto-wake SHALL NOT introduce a separate target-resolution mechanism

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
