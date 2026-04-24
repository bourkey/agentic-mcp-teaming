## 1. Config schema

- [x] 1.1 In `src/config.ts`, add an optional `peerBus.autoWake` Zod block at the top level of `peerBus` (not under `peerBus.notifier`) with `.strict()`: `allowedCommands: z.record(z.string(), z.string())`, `defaultCommand: z.string().optional()`, `debounceMs: z.number().int().nonnegative().default(1000)`, `allowedPaneCommands: z.array(z.string()).default(["claude","bash","zsh","sh"])`.
- [x] 1.2 Add a `.refine()` on `allowedCommands` validating each value: non-empty after trim; no XML 1.0 illegal control chars (`\x00`–`\x08`, `\x0B`, `\x0C`, `\x0E`–`\x1F`, `\x7F`); no `\n` or `\r`; no bytes above `\x7E`; length at most 512 bytes. Error messages SHALL name the offending key.
- [x] 1.3 Add a `.superRefine` cross-field check rejecting configs where `defaultCommand` references a key absent from `allowedCommands`.
- [x] 1.4 Extend the `McpConfig` TypeScript type so `peerBus.autoWake` is optional and fully typed; update any call sites that destructure `peerBus.notifier` to tolerate the new sibling field.
- [x] 1.5 Unit test in `tests/config.test.ts`: valid config with `allowedCommands: { "claude-inbox": "/opsx:peer-inbox" }` loads; `debounceMs` defaults to `1000`; `allowedPaneCommands` defaults to `["claude","bash","zsh","sh"]`.
- [x] 1.6 Unit test: config with an unknown field under `peerBus.autoWake` (e.g. `retry: true`) is rejected by `.strict()`.
- [x] 1.7 Unit test: config with `defaultCommand` pointing at a key absent from `allowedCommands` is rejected naming the dangling key.
- [x] 1.8 Unit tests for each value-level refinement: empty-string value rejected; whitespace-only value rejected; value containing `\x1b[31m` (ANSI) rejected; value containing `\n` rejected; value containing `\r` rejected; 513-byte value rejected. Each test asserts the Zod error names the offending key.
- [x] 1.9 Unit test: config declaring `peerBus.autoWake: { allowedCommands: {} }` loads successfully (empty allowlist is NOT a schema error); the handler-side rejection is tested in §2.
- [x] 1.10 Unit test: config without a `peerBus.autoWake` block loads successfully and yields `autoWake === undefined`.

## 2. Registry schema and `register_session` validation

- [x] 2.1 In `src/session/registry.ts`, extend `SessionRegistryEntry` with optional `autoWakeKey?: string` (persisted), and in-memory-only fields `lastWakeDispatchedAt?: number`, `wakesDispatched: number` (default `0`), `wakesSuppressed: number` (default `0`), `wakesFailed: number` (default `0`). Update serialisation to persist `autoWakeKey` and exclude the in-memory-only fields; update deserialisation to initialise the counters to `0`.
- [x] 2.2 On `SessionRegistry.load`, for each entry with `autoWakeKey`: if the key is absent from the currently-loaded `peerBus.autoWake.allowedCommands` (or the block itself is absent), clear the field in-memory and log a startup `warn` naming the session and the removed key.
- [x] 2.3 In the `register_session` tool handler (`src/server/tools/peerBus.ts` or current path), add an optional `autoWakeKey: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/).nullable().optional()` input field. The format regex SHALL run BEFORE any allowlist-membership check.
- [x] 2.4 Layer the allowlist-membership check after the format check: when `peerBus.autoWake` is present and non-empty, build a dynamic `z.enum([...Object.keys(allowedCommands)])` and use `.superRefine` (or equivalent) to check membership for non-null string values. Unknown keys SHALL fail with error code `invalid_auto_wake_key` and a message that lists the accepted keys but does NOT echo the rejected input.
- [x] 2.5 For the `null` case: when `autoWakeKey: null` and `defaultCommand` is configured, resolve to the default and store `autoWakeKey: <default>` on the registry entry. When `null` and no `defaultCommand`, reject with `invalid_auto_wake_key` and a message stating no default is configured.
- [x] 2.6 Handler-stage rejection (before schema evaluation for the allowlist-membership branch): when `autoWakeKey` (any value) is present and `peerBus.autoWake` is absent OR `allowedCommands` is empty, reject with error code `auto_wake_disabled` and the fixed message `"auto-wake is disabled on this coordinator"`.
- [x] 2.7 Add `invalid_auto_wake_key` and `auto_wake_disabled` to the peer-bus error-code enum; update any error-response shaping to include `code` and `message` consistently.
- [x] 2.8 Unit test: format-invalid `autoWakeKey` (containing `\n`, ANSI escape, over 64 chars, or disallowed punctuation) is rejected with code `invalid_auto_wake_key`; the error message does NOT contain the submitted value.
- [x] 2.9 Unit test: well-formed unknown `autoWakeKey` is rejected with code `invalid_auto_wake_key`; message lists valid keys; message does NOT contain the rejected substring.
- [x] 2.10 Unit test: `autoWakeKey` with `peerBus.autoWake` absent → rejected with code `auto_wake_disabled`; message equals `"auto-wake is disabled on this coordinator"`.
- [x] 2.11 Unit test: `autoWakeKey` with `allowedCommands: {}` → rejected with code `auto_wake_disabled`.
- [x] 2.12 Unit test: `autoWakeKey: null` with `defaultCommand` configured → resolves to the default and persists on the entry.
- [x] 2.13 Unit test: `autoWakeKey: null` with no `defaultCommand` → rejected with code `invalid_auto_wake_key`.
- [x] 2.14 Unit test: `register_session` without `autoWakeKey` behaves exactly as before this change.
- [x] 2.15 Unit test: a `register_session` with valid `autoWakeKey` and invalid/missing `Authorization: Bearer` is rejected by the token gate with `401 Unauthorized` before any Zod validation runs.
- [x] 2.16 Unit test: `SessionRegistry.load` clears `autoWakeKey` when the key is no longer in `allowedCommands` and logs a startup warn; unaffected entries retain the field.
- [x] 2.17 Unit test: a pre-change `registry.json` (entries with no `autoWakeKey` field at all) loads successfully; entries are opt-out; no back-fill occurs.

## 3. `WakeBackend` interface and `TmuxWakeBackend`

- [x] 3.1 Create `src/peerBus/wakeBackend.ts` exporting the `WakeBackend` interface with `isPaneStateSafe(target: string): Promise<{ safe: boolean; currentCommand: string }>` and `sendKeys(target: string, resolvedCommand: string): Promise<void>`.
- [x] 3.2 Create `src/peerBus/backends/tmuxWakeBackend.ts` implementing `WakeBackend`:
  - `isPaneStateSafe` runs `execFile("tmux", ["display-message", "-p", "-t", target, "#{pane_current_command}"])`, trims output, checks membership in `allowedPaneCommands`. On non-zero exit or signal, returns `{ safe: false, currentCommand: "<probe_failed>" }`.
  - `sendKeys` makes exactly two `execFile` calls in sequence: `execFile("tmux", ["send-keys", "-l", "-t", target, resolvedCommand])` then `execFile("tmux", ["send-keys", "-t", target, "Enter"])`. Throws on failure of either call with the child-process error (including `exitCode` and `signal`).
- [x] 3.3 Inject `allowedPaneCommands` into `TmuxWakeBackend` at construction; do not re-read config in the hot path.
- [x] 3.4 Unit test: `isPaneStateSafe` returns `safe: true` when `pane_current_command` output is `"bash"` and allowlist is default.
- [x] 3.5 Unit test: `isPaneStateSafe` returns `safe: false` when output is `"sudo"` and allowlist is default.
- [x] 3.6 Unit test: `isPaneStateSafe` returns `safe: false, currentCommand: "<probe_failed>"` when tmux exits non-zero.
- [x] 3.7 Unit test (top-of-file `vi.mock("child_process")`): `sendKeys("main", "/opsx:peer-inbox")` produces exactly two execFile calls with argv `["send-keys","-l","-t","main","/opsx:peer-inbox"]` and `["send-keys","-t","main","Enter"]` respectively, with no shell interpolation.

## 4. `wakeDispatcher` module

- [x] 4.1 Create `src/peerBus/wakeDispatcher.ts` exporting `dispatchWake(opts: { recipient: SessionRegistryEntry, resolvedCommand: string, commandKey: string, messageId: string, backend: WakeBackend, logger: AuditLogger, debounceMs: number }): Promise<void>`.
- [x] 4.2 Implementation sequence inside the recipient's registry mutex:
  - Resolve `recipient.autoWakeKey` against the live allowlist. If not found, emit `wake_suppressed { reason: "key_no_longer_in_allowlist" }`, increment `wakesSuppressed`, return.
  - Call `backend.isPaneStateSafe(target)`. If `safe: false`, emit `wake_suppressed { reason: "pane_state_unsafe", currentCommand }`, increment `wakesSuppressed`, return.
  - Check debounce: if `now - recipient.lastWakeDispatchedAt < debounceMs`, emit `wake_suppressed { reason: "debounce" }`, increment `wakesSuppressed`, return.
  - Write `recipient.lastWakeDispatchedAt = now` inside the mutex.
- [x] 4.3 Outside the mutex: call `backend.sendKeys(target, resolvedCommand)`. On success, emit `wake_dispatched { status: "ok" }`, increment `wakesDispatched`. On failure, emit `wake_dispatched { status: "failed", exitCode, signal }` AND log a `warn` with only `{ target, commandKey, exitCode, signal }`, increment `wakesFailed`. Do NOT retry. Do NOT propagate the failure.
- [x] 4.4 Wire `dispatchWake` into the existing `send_message` fan-out alongside the passive `notifierTmux` path. Both paths SHALL run independently: passive-notifier failure does not block wake dispatch; wake-dispatch failure does not block the passive notifier; neither path causes `send_message` to fail.
- [x] 4.5 Reduce `src/peerBus/notifierTmux.ts` to its passive-decoration responsibility. Remove any wake logic that creeps in.
- [x] 4.6 Unit test: fan-out on `send_message` for a recipient with `autoWakeKey` triggers both `set-window-option` and the wakeDispatcher path.
- [x] 4.7 Unit test: fan-out on `send_message` for a recipient without `autoWakeKey` triggers only `set-window-option`; no `WakeBackend` method is invoked; no `wake_*` audit entries are written.
- [x] 4.8 Unit test: passive-notifier failure does not prevent wake dispatch; wake-dispatch failure does not prevent passive notifier; neither path causes `send_message` to fail.

## 5. Debounce semantics

- [x] 5.1 Unit test with `vi.useFakeTimers()`: five `send_message` calls for recipient `main` within 500 ms yield exactly one `dispatchWake` backend invocation; four `wake_suppressed { reason: "debounce" }` audit entries; five passive `set-window-option` calls.
- [x] 5.2 Unit test: two concurrent `send_message` calls for distinct recipients (`main`, `backend`) both produce a wake dispatch; neither suppresses the other.
- [x] 5.3 Unit test: two `send_message` calls for `main` separated by `debounceMs + 1` ms both produce wake dispatches.
- [x] 5.4 Unit test: same-tick concurrency (two `send_message` calls for `main` resolving in the same event-loop tick, simulated by suspending the mutex briefly) produces exactly one wake dispatch; the second call emits `wake_suppressed { reason: "debounce" }`.
- [x] 5.5 Unit test: a failed wake dispatch still updates `lastWakeDispatchedAt` so a message arriving 200 ms later (with `debounceMs: 1000`) is suppressed rather than retried.
- [x] 5.6 Unit test: a pane-state-unsafe suppression does NOT update `lastWakeDispatchedAt`; an immediately following `send_message` for the same recipient, if the pane is now safe, dispatches without debounce suppression.
- [x] 5.7 Unit test: coordinator restart (simulated via a fresh `SessionRegistry` constructed from the same `registry.json`) resets `lastWakeDispatchedAt` to unset; the first post-restart message dispatches immediately.

## 6. Audit and counters

- [x] 6.1 Ensure every `wake_*` audit entry uses UTC ISO-8601 with trailing `Z` (`dispatchedAt`, `suppressedAt`). Reuse the existing audit-logger timestamp helper.
- [x] 6.2 Unit test: successful dispatch emits `wake_dispatched { status: "ok" }` with `target`, `commandKey`, `messageId`, UTC `dispatchedAt` ending in `Z`; entry does NOT contain the resolved command string, argv, tokens, or `tokenHash`.
- [x] 6.3 Unit test: failed dispatch emits `wake_dispatched { status: "failed", exitCode, signal }`; entry does NOT contain the resolved command string.
- [x] 6.4 Unit test: each of the three suppression reasons produces a `wake_suppressed` entry with the correct `reason` and no `send-keys` keystrokes sent.
- [x] 6.5 Unit test: counters (`wakesDispatched`, `wakesSuppressed`, `wakesFailed`) on the registry entry increment on the correct events; do not increment on recipients without `autoWakeKey`; reset to zero on restart.
- [x] 6.6 Unit test: recipients without `autoWakeKey` produce no `wake_*` entries on `send_message` delivery.

## 7. Sender-influence prohibition

- [x] 7.1 Unit test: a `send_message` with `body: "$(rm -rf /)"` and `messageId: "abc123"` targeting a recipient with `autoWakeKey: "claude-inbox"` produces `execFile` argv identical to the argv produced by a `send_message` with `body: ""` — i.e. `["send-keys","-l","-t","<target>","/opsx:peer-inbox"]` and `["send-keys","-t","<target>","Enter"]`. No substring of `body`, `messageId`, or any other sender-controlled field appears in the argv.
- [x] 7.2 Unit test: a `send_message` body containing backticks, dollar-signs, semicolons, and pipe characters produces identical argv to an empty-body call.

## 8. Documentation

- [x] 8.1 `README.md` — add a "Making your Claude Code session peer-reactive" section describing: (a) a `Stop` hook in `.claude/settings.json` that runs `coordinator read --wrap-for-prompt` and blocks the stop with the resulting `<peer-inbox>` content, (b) a registration step invoking `coordinator register --auto-wake claude-inbox` (from `coordinator-client-cli`) OR the raw MCP-tool `register_session` with `autoWakeKey: "claude-inbox"` until that CLI lands. Include an example `peerBus.autoWake` block with `allowedCommands: { "claude-inbox": "/opsx:peer-inbox" }`, `debounceMs: 1000`, and `allowedPaneCommands: ["claude","bash","zsh","sh"]`.
- [x] 8.2 `README.md` — call out explicitly that operators SHOULD only enable auto-wake on panes dedicated to the agent runtime. Include the pane-state safety gate's list of default-allowlisted commands, and a concrete list of commands that WILL cause suppression (`sudo`, `less`, `man`, `ssh`, `git commit` when $EDITOR is configured, a Claude Code permission prompt).
- [x] 8.3 `README.md` — document that `read_messages` is idempotent-on-drain, so the Stop hook and wake-injected inbox command compose cleanly (whichever fires first drains; the other sees an empty inbox).
- [x] 8.4 `README.md` — document that operators using non-default shells (fish, nushell) need to add their shell to `allowedPaneCommands`.
- [x] 8.5 `CLAUDE.md` — add a security note: `allowedCommands` is the authoritative boundary for injected content; `send-keys -l` prevents tmux key reinterpretation but NOT terminal control sequences — the config-schema value scrub is the actual mitigation. Add a reminder that no `send_message` field (body, metadata, messageId, sender identity) ever reaches the `send-keys` argv.

## 9. Final verification

- [x] 9.1 `npm run build && npm test` — all tests green, no regressions in existing peer-bus or notifier tests.
- [x] 9.2 Manual smoke test: start `npm start -- serve` with an `mcp-config.json` containing `peerBus.autoWake.allowedCommands: { "test-wake": "echo peer-wake-received" }` (the allowlist value is opaque to the coordinator; slash commands and shell commands are both valid examples depending on the recipient pane host). Register a session with `autoWakeKey: "test-wake"` against a live tmux window running `bash`. Send a message. Confirm the window receives `echo peer-wake-received` + Enter; the audit log contains a `wake_dispatched { status: "ok" }` entry with `commandKey: "test-wake"` and no resolved-string leakage; the registry entry's `wakesDispatched` counter is `1`.
- [x] 9.3 Manual smoke test: repeat 9.2 but start the recipient pane under `sudo su` (so `pane_current_command` is `su`). Confirm the coordinator emits `wake_suppressed { reason: "pane_state_unsafe" }` and the pane receives no keystrokes; the `wakesSuppressed` counter is `1`.
- [x] 9.4 Manual smoke test: repeat 9.2 with the target tmux window intentionally absent. Confirm the coordinator logs a `warn` with exit code, emits `wake_dispatched { status: "failed" }`, increments `wakesFailed`, and `send_message` returns success.
- [x] 9.5 Manual smoke test: edit `mcp-config.json` to remove the `test-wake` key, restart the coordinator, confirm the startup warn names the affected session and the cleared key, and confirm subsequent `send_message` calls for that recipient emit neither `wake_dispatched` nor `wake_suppressed` (because the registry entry now has no `autoWakeKey`).
