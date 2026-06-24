# cmux-notifier Specification

## Purpose
TBD - created by archiving change cmux-backend-integration. Update Purpose after archive.
## Requirements
### Requirement: cmux notifier delivers inbox notification via `cmux notify` using `displayMessageFormat`

When `peerBus.backend` is `"cmux"` and `peerBus.notifier.cmuxEnabled` is `true`, the coordinator SHALL call `execFile("cmux", ["notify", "--title", "peer-bus", "--body", <scrubbed-body>])` after each successful `send_message` delivery. The notification body SHALL be produced by `scrubForCmux(formatMessage(config, envelope))`, where:

- `formatMessage` reuses the existing `peerBus.notifier.displayMessageFormat` template with the same `{from}` and `{kind}` substitutions as the tmux notifier. No new config field is introduced.
- `scrubForCmux` strips control characters (C0 range `\x00–\x1F`, DEL `\x7F`) and newlines. No tmux format-language characters (`#{}`) require treatment. The scrubbed body SHALL be truncated to a maximum of 256 UTF-8 bytes (appending `…` if truncated) to prevent notification popup flooding and limit social-engineering surface.

The `execFile` call SHALL be fire-and-forget with a 5000 ms timeout. A non-zero exit, ENOENT (`"cmux binary not found — check PATH"`), or timeout SHALL emit a structured `warn` and SHALL NOT propagate to the `send_message` caller.

#### Scenario: cmux notify call uses expected argv with displayMessageFormat body
- **WHEN** a `send_message` is delivered with `peerBus.backend: "cmux"`, `cmuxEnabled: true`, `displayMessageFormat: "peer-bus: from {from} kind {kind}"`
- **THEN** `execFile` SHALL be called with `["cmux", "notify", "--title", "peer-bus", "--body", "peer-bus: from <sender> kind <kind>"]` where the body contains no control characters or newlines and is at most 256 bytes

#### Scenario: Notification body is truncated at 256 bytes
- **WHEN** the formatted message body exceeds 256 UTF-8 bytes
- **THEN** the body passed to `cmux notify --body` SHALL be truncated to 256 bytes and appended with `…`

#### Scenario: Notifier ENOENT is non-fatal
- **WHEN** the `cmux` binary is not found on PATH
- **THEN** the notifier SHALL emit a `warn` containing "cmux binary not found" and SHALL NOT cause `send_message` to fail

#### Scenario: Notifier failure does not block wake dispatch
- **WHEN** the cmux notify call exits non-zero
- **THEN** the wake dispatcher path SHALL still be invoked if the recipient has an `autoWakeKey`

### Requirement: cmux notifier sets sidebar badge on first unread message; clears on `read_messages`; re-validates `cmuxSurfaceId` before every `execFile` call

When `peerBus.backend` is `"cmux"` and `peerBus.notifier.cmuxEnabled` is `true`, the coordinator SHALL manage the sidebar badge per recipient as follows:

The cmux badge API is **key-based and workspace-scoped**, not surface-scoped. The badge status key SHALL be `"peer-bus"` (constant). The registry entry MUST also store `cmuxWorkspaceId` (from `CMUX_WORKSPACE_ID` env var at registration) so the coordinator can target the correct workspace sidebar.

**Set badge:** Call `execFile("cmux", ["set-status", "peer-bus", "unread", "--workspace", <cmuxWorkspaceId>])` only when the recipient's unread message count transitions from zero to one (i.e. the mailbox was empty before this delivery). Subsequent deliveries while unread messages exist SHALL NOT produce additional `set-status` calls.

**Clear badge:** Call `execFile("cmux", ["clear-status", "peer-bus", "--workspace", <cmuxWorkspaceId>])` after `read_messages` completes and the recipient's unread count drops to zero. This is wired via an optional `clearCmuxBadge(workspaceId: string)` hook on the `PeerBusContext` notifier object, set at coordinator startup when `backend: "cmux"`. The `read_messages` tool calls `context.notifier?.clearCmuxBadge?.(entry.cmuxWorkspaceId)` if both the hook and `cmuxWorkspaceId` are present.

**`cmuxWorkspaceId` validation:** Before constructing either `execFile` call, the coordinator SHALL validate `cmuxWorkspaceId` against `CMUX_WORKSPACE_ID_REGEX` (`/^workspace:\d+$/`). If validation fails, emit a structured `warn` and skip.

Both calls follow fire-and-forget semantics with 5000 ms timeout, warn-on-failure, non-fatal.

#### Scenario: Badge set only on first unread message delivery
- **WHEN** a `send_message` is delivered for a recipient with `cmuxWorkspaceId: "workspace:2"` AND the recipient's mailbox was previously empty
- **THEN** `execFile("cmux", ["set-status", "peer-bus", "unread", "--workspace", "workspace:2"])` SHALL be called exactly once

#### Scenario: Badge not re-set when mailbox already has unread messages
- **WHEN** a second `send_message` is delivered for a recipient whose mailbox already contains one unread message
- **THEN** `execFile("cmux", ["set-status", ...])` SHALL NOT be called again

#### Scenario: Badge cleared on `read_messages` via PeerBusContext hook
- **WHEN** a recipient calls `read_messages` and the context has a `clearCmuxBadge` hook AND the recipient has `cmuxWorkspaceId`
- **THEN** `execFile("cmux", ["clear-status", "peer-bus", "--workspace", <cmuxWorkspaceId>])` SHALL be called after the read completes

#### Scenario: Invalid or missing `cmuxWorkspaceId` skips badge call
- **WHEN** the registry entry has a malformed or absent `cmuxWorkspaceId`
- **THEN** no `set-status` or `clear-status` call SHALL be made; a `warn` SHALL be emitted if the value is present but malformed; silent skip if absent

