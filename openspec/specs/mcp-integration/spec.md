# MCP Integration Specification

## Purpose

Defines how the coordinator exposes its agent-trigger tools and externalized configuration, including auto-wake registration, allowlist validation of `autoWakeKey`, and the stable auto-wake error-code enum.
## Requirements
### Requirement: Coordinator exposes agent trigger tools
The coordinator MCP server SHALL expose exactly one agent trigger tool: `invoke_agent(agentId, prompt, context?, invocationContext)`. The tools `invoke_claude` and `invoke_codex` SHALL NOT be registered. All agent invocations in the workflow SHALL go through `invoke_agent` exclusively.

The coordinator SHALL also expose a second tool: `invoke_reviewer(reviewerId, stage, artifacts, invocationContext)` for dispatching external CLI peer reviewers during review gates. This tool wraps the existing `invoke_agent` subprocess logic but returns structured `ReviewerFindings` instead of `AgentMessage`.

#### Scenario: Agent invoked via `invoke_agent`
- **WHEN** the workflow loop calls `invoke_agent` with a registered `agentId`, a prompt, and an artifact context
- **THEN** the coordinator SHALL apply the agent's specialty prompt, spawn the CLI subprocess, wrap the response as an `AgentMessage`, return it as the MCP tool result, and log the invocation with full call-tree IDs to the audit log

#### Scenario: External reviewer invoked via `invoke_reviewer`
- **WHEN** Claude in the VS Code session calls `invoke_reviewer` with a reviewer ID and stage artifacts
- **THEN** the coordinator SHALL spawn the reviewer's CLI subprocess, pass artifact content as context, and return structured `ReviewerFindings` (array of finding, severity, proposed fix)

#### Scenario: Agent trigger tool times out
- **WHEN** `invoke_agent` is called and the CLI subprocess does not return within the configured timeout
- **THEN** the tool SHALL treat the response as a `block`, log an `agent_error` entry, and the workflow SHALL escalate to a human checkpoint

#### Scenario: Reviewer tool times out
- **WHEN** `invoke_reviewer` is called and the CLI subprocess does not return within the configured timeout
- **THEN** the tool SHALL return an empty findings list with a timeout warning, allowing the gate to proceed with other reviewers

#### Scenario: Removed tool name called
- **WHEN** an MCP client calls `invoke_claude` or `invoke_codex`
- **THEN** the MCP server SHALL return a standard unknown-tool error response

### Requirement: MCP server configuration is externalized
The coordinator MCP server configuration SHALL include the agent registry map, `consensus` policy block, `spawning` guardrail block, and `reviewers` block in `mcp-config.json`. Agent CLI paths, specialties, review/revision/implementation capability flags, sub-invocation permissions, consensus round limits, spawning thresholds, and reviewer definitions SHALL be configurable without source changes.

#### Scenario: Custom agent registry loaded
- **WHEN** the coordinator starts and reads `mcp-config.json`
- **THEN** the MCP server SHALL register `invoke_agent` and validate every agent entry in the registry before accepting any connections

#### Scenario: Reviewers block parsed
- **WHEN** the coordinator starts and reads `mcp-config.json`
- **THEN** entries in the `reviewers` block are validated; entries with `cli` are external CLI reviewers; entries without `cli` are Claude sub-agent definitions

#### Scenario: Spawning config applied
- **WHEN** `mcp-config.json` specifies `spawning.maxDepth: 3`
- **THEN** the coordinator SHALL enforce a depth limit of 3 for all `invoke_agent` calls in that session

#### Scenario: Session state loaded from pre-change run
- **WHEN** the coordinator resumes a session whose `state.json` predates the new spawn-tracking fields
- **THEN** the loader SHALL backfill missing spawn-tracking state with default values before validating and continuing the session

### Requirement: `register_session` accepts and validates optional `autoWakeKey` against the operator allowlist

The `register_session` MCP tool SHALL accept an optional `autoWakeKey` field on its input payload. The field type SHALL be `string | null | undefined`. The `autoWakeKey` value, when present, SHALL be validated against the coordinator's loaded `peerBus.autoWake.allowedCommands` configuration and rejected per the error-code contract below. A registration without the `autoWakeKey` field SHALL succeed and record no auto-wake state on the registry entry.

The existing `Authorization: Bearer` token gate SHALL apply unchanged when the `autoWakeKey` field is present; the presence of `autoWakeKey` SHALL NOT bypass, short-circuit, or alter token validation.

The Zod schema for the `autoWakeKey` field SHALL impose a format constraint `^[a-zA-Z0-9_-]{1,64}$` BEFORE the allowlist-membership check. Keys failing the format constraint SHALL be rejected at the Zod boundary with error code `invalid_auto_wake_key` and a generic message that does NOT echo the submitted value.

#### Scenario: Registration without `autoWakeKey` is unchanged
- **WHEN** `register_session` is called without the `autoWakeKey` field
- **THEN** the registration SHALL succeed with the same behaviour as before this change; no auto-wake state SHALL be recorded on the registry entry; no audit events in the `wake_*` family SHALL be emitted on subsequent `send_message` deliveries to this recipient

#### Scenario: Registration with a valid allowlist key succeeds
- **WHEN** `register_session` is called with `autoWakeKey: "claude-inbox"` AND `claude-inbox` is a key in `peerBus.autoWake.allowedCommands`
- **THEN** the registration SHALL succeed and the `autoWakeKey` field SHALL be stored on the registry entry and persisted to `registry.json`

#### Scenario: Registration with an explicit null opts into `defaultCommand`
- **WHEN** `register_session` is called with `autoWakeKey: null` AND `peerBus.autoWake.defaultCommand` is set to `"claude-inbox"` AND `claude-inbox` is a key in `allowedCommands`
- **THEN** the registration SHALL succeed and the registry entry SHALL store `autoWakeKey: "claude-inbox"` resolved from the default

#### Scenario: Registration with explicit null and no `defaultCommand` is rejected
- **WHEN** `register_session` is called with `autoWakeKey: null` AND `peerBus.autoWake.defaultCommand` is absent
- **THEN** the registration SHALL be rejected with error code `invalid_auto_wake_key` and a message stating that no default is configured

#### Scenario: Format-invalid `autoWakeKey` is rejected without echoing the input
- **WHEN** `register_session` is called with an `autoWakeKey` that does not match `^[a-zA-Z0-9_-]{1,64}$` (for example containing a newline, ANSI escape, over 64 characters, or disallowed punctuation)
- **THEN** the registration SHALL be rejected at the Zod boundary with error code `invalid_auto_wake_key` and the error message SHALL NOT contain the submitted value

#### Scenario: Well-formed unknown `autoWakeKey` lists accepted keys but does not echo the rejected value
- **WHEN** `register_session` is called with `autoWakeKey: "nonexistent-key"` that matches the format constraint but is not present in `peerBus.autoWake.allowedCommands`
- **THEN** the registration SHALL be rejected with error code `invalid_auto_wake_key`; the error message SHALL list the accepted allowlist keys; the error message SHALL NOT contain the substring `nonexistent-key`

#### Scenario: Registration with `autoWakeKey` when config block absent is rejected
- **WHEN** `register_session` is called with any `autoWakeKey` value (string or null) AND `peerBus.autoWake` is absent from the loaded config
- **THEN** the registration SHALL be rejected with error code `auto_wake_disabled` and a message stating that auto-wake is disabled on this coordinator

#### Scenario: Registration with `autoWakeKey` when `allowedCommands` is empty is rejected
- **WHEN** `register_session` is called with any `autoWakeKey` value AND `peerBus.autoWake.allowedCommands` is `{}`
- **THEN** the registration SHALL be rejected with error code `auto_wake_disabled` and a message stating that auto-wake is disabled on this coordinator

#### Scenario: Invalid bearer token rejects regardless of `autoWakeKey` presence
- **WHEN** `register_session` is called with a valid `autoWakeKey` AND an invalid or missing `Authorization: Bearer` token
- **THEN** the request SHALL be rejected by the token gate with `401 Unauthorized` before any Zod validation of the `autoWakeKey` field

### Requirement: `mcp-config.json` schema declares the auto-wake configuration block with value-level validation

`src/config.ts` SHALL define `peerBus.autoWake` as an optional `.strict()` Zod block nested directly under `peerBus` (not under `peerBus.notifier`). The block SHALL contain:

- `allowedCommands: z.record(z.string(), z.string())` with a `.refine()` validating that every value:
  - is non-empty after whitespace trim
  - contains no XML 1.0 illegal control characters (`\x00`–`\x08`, `\x0B`, `\x0C`, `\x0E`–`\x1F`, `\x7F`)
  - contains no newline characters (`\n` or `\r`)
  - contains no bytes above `\x7E`
  - is at most 512 bytes in length
- `defaultCommand?: z.string()` — optional; when present, SHALL reference an existing key in `allowedCommands` (cross-field `.superRefine`); consumed only on explicit opt-in via `autoWakeKey: null` at registration time
- `debounceMs: z.number().int().nonnegative().default(1000)` — per-recipient debounce window in milliseconds
- `allowedPaneCommands: z.array(z.string()).default(["claude", "bash", "zsh", "sh"])` — pane-state safety gate allowlist; membership tested against trimmed `tmux display-message '#{pane_current_command}'` output before each wake dispatch

When the `peerBus.autoWake` block is absent from the loaded config, the coordinator SHALL treat auto-wake as disabled and reject any `register_session` that includes `autoWakeKey` with error code `auto_wake_disabled`. When the block is present with an empty `allowedCommands`, `register_session` calls with `autoWakeKey` SHALL similarly be rejected at the handler with error code `auto_wake_disabled`; this case is NOT a `loadConfig` schema error.

#### Scenario: Strict schema rejects unknown fields
- **WHEN** the config file includes an unknown field under `peerBus.autoWake` (e.g. `peerBus.autoWake.retry: true`)
- **THEN** `loadConfig` SHALL reject the config with a Zod error naming the unknown field

#### Scenario: `defaultCommand` references the allowlist
- **WHEN** the config declares `defaultCommand: "claude-inbox"` AND `allowedCommands` does not contain that key
- **THEN** `loadConfig` SHALL reject the config with an error naming the dangling default key

#### Scenario: Empty-string allowlist value is rejected at config load
- **WHEN** the config declares `allowedCommands: { "key-1": "" }` OR a whitespace-only value
- **THEN** `loadConfig` SHALL reject the config with a Zod error naming the offending key

#### Scenario: Control-character allowlist value is rejected at config load
- **WHEN** the config declares `allowedCommands: { "key-1": "/opsx:inbox\x1b[31m" }` (containing an ANSI escape sequence) OR any value containing bytes in the illegal control-character set
- **THEN** `loadConfig` SHALL reject the config with a Zod error naming the offending key

#### Scenario: Newline-containing allowlist value is rejected at config load
- **WHEN** the config declares `allowedCommands: { "key-1": "/opsx:inbox\narg" }`
- **THEN** `loadConfig` SHALL reject the config with a Zod error naming the offending key

#### Scenario: Oversize allowlist value is rejected at config load
- **WHEN** the config declares an `allowedCommands` value exceeding 512 bytes
- **THEN** `loadConfig` SHALL reject the config with a Zod error naming the offending key

#### Scenario: Missing `debounceMs` defaults to 1000
- **WHEN** the config declares `peerBus.autoWake` with `allowedCommands` but no `debounceMs`
- **THEN** the loaded config SHALL have `debounceMs: 1000`

#### Scenario: Missing `allowedPaneCommands` defaults to the agent-runtime shells
- **WHEN** the config declares `peerBus.autoWake` with `allowedCommands` but no `allowedPaneCommands`
- **THEN** the loaded config SHALL have `allowedPaneCommands: ["claude", "bash", "zsh", "sh"]`

#### Scenario: Empty allowlist loads successfully but rejects registrations
- **WHEN** the config declares `peerBus.autoWake: { allowedCommands: {} }` (explicit empty)
- **THEN** `loadConfig` SHALL succeed; any subsequent `register_session` call with `autoWakeKey` SHALL be rejected at the handler with error code `auto_wake_disabled`

### Requirement: Auto-wake error codes are stable members of the peer-bus error-code enum

The peer-bus error-code enum SHALL gain two stable codes for the auto-wake rejection paths:

- `invalid_auto_wake_key` — returned when `register_session` receives an `autoWakeKey` that is format-invalid, well-formed but not in `allowedCommands`, or `null` when no `defaultCommand` is configured.
- `auto_wake_disabled` — returned when `register_session` receives an `autoWakeKey` but `peerBus.autoWake` is absent from config OR `allowedCommands` is empty.

Error responses carrying these codes SHALL follow the existing peer-bus error-response shape (a response object with at minimum the `code` and `message` fields). Error messages for `invalid_auto_wake_key` SHALL list the set of accepted allowlist keys but SHALL NOT echo the rejected input.

#### Scenario: `invalid_auto_wake_key` response shape
- **WHEN** a `register_session` call is rejected for any of the four `invalid_auto_wake_key` causes (format, unknown, null-without-default)
- **THEN** the response body SHALL be a standard peer-bus error response with `code: "invalid_auto_wake_key"` and a `message` field; the response SHALL NOT include a `kind` hint derived from `send_message` nor any sender-supplied content

#### Scenario: `auto_wake_disabled` response shape
- **WHEN** a `register_session` call is rejected because auto-wake is disabled (absent block or empty allowlist)
- **THEN** the response body SHALL be a standard peer-bus error response with `code: "auto_wake_disabled"` and a `message` equal to `"auto-wake is disabled on this coordinator"`

### Requirement: invoke_reviewer returns structured ReviewerFindings
The `invoke_reviewer` MCP tool SHALL return a structured response containing an array of findings, each with a finding description, severity hint (`critical`, `major`, `minor`), proposed fix, and the file or artifact section the finding applies to.

#### Scenario: ReviewerFindings returned on success
- **WHEN** `invoke_reviewer` completes successfully
- **THEN** the tool result contains `{ findings: Array<{ finding: string, severity: string, proposedFix: string, location: string }> }`

#### Scenario: Empty findings returned when reviewer finds no issues
- **WHEN** the external reviewer CLI returns cleanly with no findings
- **THEN** the tool result contains `{ findings: [] }`

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

