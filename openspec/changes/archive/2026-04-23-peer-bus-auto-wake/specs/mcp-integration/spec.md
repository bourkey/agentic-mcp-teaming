## ADDED Requirements

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
