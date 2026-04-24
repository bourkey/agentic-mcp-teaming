## Context

The peer-session-bus was shipped in `peer-session-bus` (archived 2026-04-21) with a single notifier mechanism: on every `send_message`, invoke `tmux set-window-option -t <target>:<window> window-status-style <unreadTabStyle>` via `execFile` to decorate the recipient's window bar. The design assumed an operator would notice the visual cue and prompt their Claude Code session to run `read_messages`, or that the recipient session was already mid-turn and would call `read_messages` at a natural beat.

Practice has diverged from that assumption. Observed during `coordinator-streamable-http` exploration, recipients `main`, `misc`, and `backend` all received messages through the bus while having no tmux windows — the notifier warned (`set-window-option failed`, code 1) and moved on, and the producers never learned the work had nowhere to land. The pattern is the classic producer-consumer liveness gap: Claude Code sessions are turn-based, there is no background poll loop, and without a wake signal an idle session cannot notice inbound work.

The fix has to come from the coordinator side. A consumer-side polling daemon per project duplicates exactly the kind of plumbing `coordinator-client-cli` was introduced to eliminate, and it also fails to solve the "session is idle because it just finished, waiting for the next prompt" case — only the coordinator knows when a new message has arrived. The notifier's existing tmux access and per-recipient dispatch are the natural foundation; extending them with an active `send-keys` injection that types a pre-declared command into the pane drives Claude Code into a new turn without any change to Claude Code itself. But the auto-wake machinery (allowlist resolution, debounce, pane-state safety gate, audit event family, failure handling, health counters) is a distinct concern from passive window-bar decoration, and belongs in its own module — keeping the notifier honest about what it is (cosmetic) and leaving room for future non-tmux backends without rewriting the dispatch state machine.

Constraints from the existing codebase:
- `execFile` (never `exec`, never `spawn { shell: true }`) for every tmux invocation. No string interpolation into the shell.
- The peer-bus registry (`SessionRegistry`) stores only `sha256(token)` and session metadata; any `autoWakeKey` setting is metadata, never sensitive. Persisting `autoWakeKey` to `registry.json` is safe; persisting the ephemeral `lastWakeDispatchedAt` is not desirable.
- The registry entry already holds the per-session serialisation mutex used by the peer-bus message path — putting the debounce timestamp on the entry makes check-and-set atomic by construction and closes the same-tick concurrency race that a notifier-local map would leave open.
- Error codes on peer-bus rejections are a stable enum (`invalid_session_name`, `invalid_session_token`, etc. from the archived bus proposal). New rejection paths MUST fit that enum shape, not bespoke string messages.

## Goals / Non-Goals

**Goals:**
- Wake idle tmux-hosted sessions when peer-bus messages arrive for them.
- Keep the injection payload under operator control, with a small, auditable allowlist declared in `mcp-config.json` whose *values* are also validated (not just keys) so terminal control sequences cannot slip past `send-keys -l`.
- Remain CLI-agnostic at the dispatcher layer — Claude Code panes, Codex CLIs, bash watchers, and Python agent harnesses SHALL all be expressible via different allowlist entries; a future non-tmux backend SHALL NOT require touching the dispatcher.
- Preserve the existing passive `set-window-option` decoration unchanged as the fallback for sessions that have not opted in.
- Prevent injection into interactive prompts via a pane-state safety gate that only allows dispatch when the target pane's current command matches an operator-declared allowlist of known-safe agent runtimes.
- Give operators a health signal — counters readable through the existing audit-log aggregation layer — so "is auto-wake firing?" is answerable without log spelunking.
- Preserve the existing security posture: `execFile` with args-as-array, no shell, no string interpolation, no raw command strings from senders, no raw strings from registrants, audit-log entries that never contain the resolved command string or any sender-controlled input.

**Non-Goals:**
- Implementing the consumer-side `Stop` hook. That lives in each project's `.claude/settings.json` and is a documentation/recipe deliverable.
- Real-time server-push via Streamable HTTP `GET /mcp` notifications. Claude Code's MCP client does not act on server-initiated notifications as of today.
- Per-message urgency (`send_message --urgent`) that bypasses debounce. Deferrable until a real use case appears.
- Cross-multiplexer auto-wake backends (screen, zellij, kitty-tabs). The `WakeBackend` interface accommodates them but this change ships only `TmuxWakeBackend`.
- A dedicated `GET /health` endpoint. Counters live on the registry and are surfaced through the same audit-log aggregation path used today.
- Hot-reload of the allowlist. Operators restart the coordinator to change it, matching every other config field.
- Letting senders influence the injected text. Explicit normative prohibition; the `send-keys` argv is derived only from the resolved allowlist entry and the target identifier.

## Decisions

### D1 — Dedicated `wakeDispatcher` module with pluggable `WakeBackend` interface

Auto-wake lives in `src/peerBus/wakeDispatcher.ts`, not in `notifierTmux.ts`. The dispatcher owns: allowlist resolution, the per-recipient debounce protocol (read/write against `SessionRegistryEntry.lastWakeDispatchedAt`), the pane-state safety gate (delegated to the backend), audit-event emission (`wake_dispatched`, `wake_suppressed`, failures), and the health counters.

The dispatcher calls into a `WakeBackend` interface:
```typescript
interface WakeBackend {
  isPaneStateSafe(target: string): Promise<{ safe: boolean; currentCommand: string }>;
  sendKeys(target: string, resolvedCommand: string): Promise<void>; // throws on failure
}
```

`TmuxWakeBackend` in `src/peerBus/backends/tmuxWakeBackend.ts` implements it via `execFile` calls to `tmux display-message -p '#{pane_current_command}'` and `tmux send-keys -l ...` / `... Enter`. The existing `notifierTmux.ts` is reduced to its passive decoration responsibility and no longer owns any wake logic.

**Alternative considered**: extend `notifierTmux.ts` in place. Rejected — conflates fire-and-forget cosmetic decoration with a stateful active-injection pipeline, names the module after a backend we already want to abstract over, and forces future backends to either duplicate the state machine or reach across a module boundary.

### D2 — Two `execFile` calls for `send-keys` (literal command + Enter)

`TmuxWakeBackend.sendKeys` makes exactly two `execFile` invocations per wake: `tmux send-keys -l -t <target> <resolvedCommand>` then `tmux send-keys -t <target> Enter`. The `-l` literal-mode flag applies only to the first call so the resolved command is not reinterpreted as tmux key names (e.g. a literal string like `C-c` is not sent as Ctrl-C). The second call delivers `Enter` as a real keystroke.

**Alternative considered**: single invocation with `"<cmd>\n"` embedding the newline. Rejected — mixes literal and key-name semantics in one argument; tmux's `\n` handling in argument strings is version-sensitive and underspecified. Two invocations are cheap, explicit, and robust.

**Alternative considered**: `paste-buffer` via `set-buffer`. Rejected — adds named buffer state that must be cleaned up; no ergonomic gain.

### D3 — Debounce state lives on `SessionRegistryEntry`; check-and-set through the registry mutex; both success and failure consume the window

`SessionRegistryEntry.lastWakeDispatchedAt?: number` holds the last dispatch timestamp (unix-ms). Before invoking `TmuxWakeBackend.sendKeys`, the dispatcher takes the existing per-session registry mutex, reads `lastWakeDispatchedAt`, compares to `now - debounceMs`, and — **in the same critical section, before any async backend call** — writes `now` back. The `execFile` call then runs outside the mutex.

This places check-and-set atomically under the same mutex that already serialises `send_message` persistence, closing the same-tick concurrency race where two messages for the same recipient could both observe a stale timestamp. It also places the debounce state where a future `deregister_session` naturally clears it by clearing the entry.

Both successful AND failed backend dispatches update the timestamp. Rationale: if `send-keys` fails (window missing, tmux down) a burst of subsequent messages must not retry-spam the backend. The debounce window is a rate limit on attempts, not just on successes.

**Alternative considered**: notifier-local `Map<string, number>`. Rejected — untangled from the registry lifetime, invisible through registry reads, duplicated per backend, and left an atomicity gap.

**Alternative considered**: update only on success. Rejected — a broken pane would cause every message to hit the backend, bloating warn logs and saturating tmux on bursts.

### D4 — `peerBus.autoWake` config block at top-level peer-bus scope, not under `peerBus.notifier`

The allowlist is a security boundary (it is the operator's sole control over what gets typed into recipient panes) and is backend-agnostic. Nesting it under `peerBus.notifier` visually subordinates it to a cosmetic-sounding parent and re-ties the wake concept to a backend name. Hoisted to `peerBus.autoWake`:

```yaml
peerBus:
  notifier:
    tmuxEnabled: true
    unreadTabStyle: "bg=yellow"
    # ...existing tmux-specific fields unchanged
  autoWake:
    allowedCommands:
      claude-inbox: "/opsx:peer-inbox"
      codex-inbox: "peer-inbox"
    defaultCommand: claude-inbox   # optional
    debounceMs: 1000               # optional; default 1000
    allowedPaneCommands:           # optional; default below
      - claude
      - bash
      - zsh
      - sh
```

**Alternative considered**: keep under `peerBus.notifier.autoWake`. Rejected on the CLI-agnostic grounds above.

### D5 — Flat `autoWakeKey` scalar on `register_session`, not nested `autoWake: { command: "…" }`

The registration payload field is a single scalar:

```typescript
autoWakeKey?: string | null;
```

Meaning:
- Absent (`undefined`): opt-out. No wake dispatch ever fires for this registration. (Back-compat with pre-change registrations.)
- `null`: explicit opt-in to `peerBus.autoWake.defaultCommand`. Rejected if no default is configured.
- String: explicit opt-in to that specific allowlist key.

Renamed from the initial `autoWake: { command: "…" }` shape for two reasons: (a) the value is a KEY, not a command — the audit-log field `commandKey` already has the right noun — so calling the registration field `command` was semantically wrong; (b) wrapping a single scalar in an object implies extension points that the proposal explicitly defers or rejects. If a second wake-related field ever materialises, the object can be reintroduced then — a trivial incompatible change.

**Alternative considered**: keep the nested object shape. Rejected for the reasons above.

**Alternative considered**: `autoWakeCommand` as the field name. Rejected — perpetuates the "command" misnomer. `autoWakeKey` makes clear the value is a reference, not a literal.

### D6 — Four registration rejection paths with stable error codes

Error codes added to the peer-bus error-code enum (per the pattern established in the archived bus proposal):

| Condition | Error code | Stage | Message shape |
|---|---|---|---|
| `autoWakeKey` format-invalid (`!/^[a-zA-Z0-9_-]{1,64}$/`) | `invalid_auto_wake_key` | Zod | `"invalid autoWakeKey format"` — does NOT echo the submitted value |
| `autoWakeKey` well-formed but unknown | `invalid_auto_wake_key` | Zod | `"unknown autoWakeKey; accepted: <keys>"` — lists accepted keys, does NOT echo rejected input |
| `autoWakeKey` supplied when `peerBus.autoWake` block absent | `auto_wake_disabled` | handler | `"auto-wake is disabled on this coordinator"` |
| `autoWakeKey` supplied when `allowedCommands` empty | `auto_wake_disabled` | handler | `"auto-wake is disabled on this coordinator"` |

The two Zod-stage rejections happen before any downstream processing (including the bearer-token check path that gates all peer-bus tool calls, which is unchanged). The two handler-stage rejections happen because a dynamic Zod enum over an empty or absent allowlist has no values to discriminate on — schema validation cannot reject; the handler must.

Format validation runs BEFORE allowlist membership. Without it, a caller could submit a key containing ANSI escapes or a token-shaped string and see it echoed in an error response or log. The format regex bounds the echo surface to `[a-zA-Z0-9_-]{1,64}` before any echo can happen; even then, the unknown-key message does not echo the submitted value — it lists accepted keys instead.

**Alternative considered**: free-form error messages without codes. Rejected — clients can only string-match, brittle across releases, inconsistent with the rest of the peer-bus error surface.

### D7 — Allowlist *values* validated at config-load time

`peerBus.autoWake.allowedCommands` is `z.record(z.string(), z.string())` with a `.refine()` that rejects any value that:
- is empty after trim
- contains XML 1.0 illegal control characters (`\x00`–`\x08`, `\x0B`, `\x0C`, `\x0E`–`\x1F`, `\x7F`) — reuses the existing peer-bus illegal-char set
- contains newline characters (`\n`, `\r`)
- contains bytes above `\x7E`
- exceeds 512 bytes

Rationale: `send-keys -l` disables tmux KEY-NAME interpretation but passes bytes straight through to the pane. A value containing ANSI/OSC sequences (`\x1b[...`, `\x1b]...\x07`) is typed into the recipient terminal literally — which means it IS interpreted by the terminal emulator. The operator-controlled config is the trust boundary; a misconfigured (or freshly-copy-pasted) value containing control bytes could retitle the window, corrupt scrollback, or exploit a terminal-emulator CVE. The config-schema scrub is the actual mitigation, not `send-keys -l`. This is documented explicitly in the spec and `CLAUDE.md` so a future implementer does not rely on `-l` as the complete defence.

**Alternative considered**: validate values at use time in `TmuxWakeBackend`. Rejected — the failure should surface at config load, not at first dispatch; operators need loud, early feedback.

**Alternative considered**: accept any string and scrub at dispatch. Rejected — silently modifying operator-declared config is worse than rejecting it.

### D8 — Pane-state safety gate via `pane_current_command`

Before emitting `send-keys`, `TmuxWakeBackend` invokes `tmux display-message -p -t <target> '#{pane_current_command}'` via `execFile`, trims the result, and checks membership in `peerBus.autoWake.allowedPaneCommands` (default `["claude", "bash", "zsh", "sh"]`). If the current command is not in the allowlist, the dispatcher emits `wake_suppressed { reason: "pane_state_unsafe" }` to the audit log and returns without sending any keystrokes.

Rationale: tmux queues `send-keys` against whatever is currently running in the pane. If the recipient is in a `sudo` prompt, a `git commit` $EDITOR session, an `ssh` host-key confirmation, a `less` pager, or a Claude Code permission dialog, the queued `/opsx:peer-inbox\n` is typed into THAT context. Typing arbitrary text + Enter into a password prompt is a credential-leak risk; typing it into a `y/N` confirmation or a permission dialog auto-confirms the operation. The safety gate closes this class of footgun at dispatch time.

The `allowedPaneCommands` list is operator-controlled so unusual setups (e.g. a recipient running a custom wrapper command) can extend the allowlist without changing code.

**Alternative considered**: document the risk in README and ship without a gate. Rejected — documentation-only mitigations for credential-leak-class risks are not the standard this project applies elsewhere (see the `execFile`-only subprocess discipline and the token-never-logged discipline).

**Alternative considered**: a deny-list of known-dangerous commands (`sudo`, `less`, `man`, `git`, …). Rejected — open-ended; new dangerous commands ship faster than we maintain the list. Allowlist is the safer shape.

**Alternative considered**: relying on the recipient Claude Code session's Stop-hook to drain the inbox after the current interactive prompt finishes. Rejected — Stop-hook and wake are complementary (see D11), but neither is a substitute for the other. The safety gate is cheap and additive.

**Escalation point** (flagged to the operator at gate time): the cost of the gate is one extra `execFile` per wake candidate. Operators who prefer documentation-only may flip to that by removing `allowedPaneCommands` from config and accepting a warn at startup — but the default is the gate, because the default should be safe.

### D9 — `defaultCommand` consumed only on explicit opt-in (`autoWakeKey: null`)

Registrations that omit `autoWakeKey` entirely are opt-out. `defaultCommand` is consumed ONLY when the registration explicitly sends `autoWakeKey: null`. This preserves the invariant that absence means opt-out (back-compat with pre-change clients) while still giving operators a way to declare a per-coordinator default that callers opt into with a single field.

**Alternative considered**: absence inherits the default. Rejected — breaks back-compat (pre-change clients would silently become opt-in) and makes the opt-out shape ambiguous.

**Alternative considered**: drop `defaultCommand` entirely. Defensible; kept for now because the opt-in-with-default shape is common in launcher scripts and removing it would push a `jq` lookup into every consumer's launcher.

### D10 — Registry persistence: `autoWakeKey` persists; `lastWakeDispatchedAt` does not; stale keys are cleared on load

`autoWakeKey` is written to `registry.json` so restart does not silently opt-out existing sessions. On `SessionRegistry.load`, each entry's `autoWakeKey` is revalidated against the currently-loaded `peerBus.autoWake.allowedCommands`:
- Still in the allowlist → kept.
- Removed from the allowlist (or the block is absent in the new config) → cleared, with a startup warn naming the session and the removed key.

`lastWakeDispatchedAt` is in-memory only. Restart resets the debounce window to "never dispatched" for every recipient — the first message after restart dispatches immediately. This is the correct semantics: the debounce is a rate-limit against busy-loops, not a cache, and restart is a clean event where no in-flight work exists.

**Alternative considered**: SHALL NOT persist `autoWakeKey` — sessions re-supply on every register_session. Rejected — forces every consumer to re-register on every coordinator restart, which breaks the long-lived-registration model `coordinator-client-cli` is built on.

**Alternative considered**: persist `lastWakeDispatchedAt`. Rejected — tiny behavioural benefit (debounce survives across a restart boundary where nothing was dispatching anyway) at the cost of a new file-write hot path.

### D11 — Composition with the `Stop`-hook consumer-side pattern: `read_messages` is idempotent-on-drain

The proposal mentions a complementary consumer-side Stop hook running `coordinator read --wrap-for-prompt`. When both the Stop hook AND auto-wake are configured for the same pane, both will eventually trigger `read_messages` against the coordinator for the same registration. This is safe and not duplicative because `read_messages` is idempotent-on-drain: calling it returns all unread envelopes and marks them read; the next call returns nothing. Whichever mechanism fires first drains the inbox; the other observes an empty inbox and becomes a no-op.

This is not a new property — it is already how `read_messages` behaves per the archived bus proposal — but stating it explicitly here prevents adopters from designing elaborate "which mechanism wins" precedence logic that is not needed.

**Alternative considered**: require consumers to disable the Stop hook when adopting auto-wake. Rejected — auto-wake covers the idle case; the Stop hook covers the "Claude just finished a turn, drain before stopping" case. They are disjoint in timing and complementary in coverage.

### D12 — Closed `wake_*` audit event family

Three audit event types, all reachable by `grep '^"type":"wake_'`:
- `wake_dispatched` — a backend dispatch was attempted. Contains `status: "ok" | "failed"` plus `exitCode?` and `signal?` on failure. (Implementations MAY emit `wake_failed` as a separate type for grep ergonomics; both forms satisfy the spec.)
- `wake_suppressed` — the dispatcher decided not to attempt. `reason: "debounce" | "pane_state_unsafe" | "key_no_longer_in_allowlist"`.
- No audit entry for registrations that never opt in — absence of `autoWakeKey` produces no audit traffic.

None of these entries contains the resolved command string, the send-keys argv, any subset of `mcp-config.json`, session tokens, or `tokenHash`. `commandKey` is the only allowlist-linked identifier that ever lands in the audit log.

**Alternative considered**: only log successes; surface failures via the existing `warn` log stream. Rejected — splits the subsystem's story across two streams with different structure, which is what we called out as a gap in the observability finding.

### D13 — Health counters on the wakeDispatcher, surfaced through audit-log aggregation

Three per-recipient in-memory counters: `wakesDispatched`, `wakesSuppressed`, `wakesFailed`. Incremented in-process, zero on-wire cost, readable through the same audit-log aggregation layer that surfaces `lastSeenAt` today. Operators get answers to:
- "Is auto-wake firing at all?" — `sum(wakesDispatched)` across recipients.
- "Am I hitting the debounce ceiling?" — `wakesSuppressed{reason=debounce}` over time.
- "Which recipients have stale tmux targets?" — `wakesFailed{target=…}` per target.

No bespoke metrics endpoint. No Prometheus surface. Reconstructable from the audit log by any operator who wants a fancier view.

**Alternative considered**: no counters, rely on log grep. Rejected — the stated motivation for this change is recovering from SILENT producer-consumer breakage; shipping a new feature whose own failure mode is "silent" would be ironic.

**Alternative considered**: dedicated `GET /health` HTTP endpoint. Deferred — nice-to-have but not on the critical path for v1.

### D14 — tmux target resolution reuses the existing notifier contract

The `-t <target>` argument for both `display-message` and `send-keys` is the recipient's registered session name — the exact same target-resolution the existing `notifier-tmux.set-window-option` call uses today. Auto-wake does not introduce a separate resolution rule. If the registered session name ever gains a session-qualified form (`sessionName:windowName`), that form SHALL be applied uniformly across `set-window-option`, `display-message`, and `send-keys`.

### D15 — Sender-controlled fields are forbidden from the `send-keys` argv

Normative requirement: the `send-keys` argv is derived only from (a) the registrant's stored `autoWakeKey` resolved through the operator-declared allowlist and (b) the target pane identifier. No field of the triggering `send_message` call — `body`, `kind`, `replyTo`, `metadata`, `messageId`, sender session name, sender `tokenHash`, HTTP headers — SHALL ever appear in the `tmux send-keys` argv. A test scenario asserts `execFile` argv equality for a call whose `send_message` body contains shell metacharacters.

### D16 — Inbound dependency on `coordinator-client-cli`

The README recipe references `coordinator register --auto-wake <key>` provided by the in-flight `coordinator-client-cli` change. If `coordinator-client-cli` has not landed at merge time, the recipe documents the raw MCP-tool `register_session` call with the `autoWakeKey` field until the CLI flag ships. The MCP-tool path is the load-bearing integration surface; the CLI flag is ergonomic sugar.

## Risks / Trade-offs

- **[Risk] Injection surface on the recipient pane even through allowlisted values.** `send-keys -l` prevents tmux key-name reinterpretation but not terminal control sequences. → **Mitigation**: D7 config-schema value scrub rejects control bytes, ANSI, newlines, and oversize values at config-load time. `CLAUDE.md` documents that the scrub IS the mitigation; `-l` is a belt, not the suspenders.
- **[Risk] Wake injection into interactive prompts (sudo, git commit, permission dialogs).** → **Mitigation**: D8 pane-state safety gate suppresses dispatch when `pane_current_command` is not in the operator allowlist. Default allowlist is agent-runtime shells only.
- **[Risk] Info-leak via echoed rejection strings.** → **Mitigation**: D6 format regex bounds key shape before any echo; even on well-formed-unknown rejections, the error message lists accepted keys rather than echoing the rejected input.
- **[Risk] Sender influences dispatch content.** → **Mitigation**: D15 normative prohibition + argv-equality test with shell-metacharacter body.
- **[Risk] Same-tick debounce races.** → **Mitigation**: D3 check-and-set under the registry's existing per-session mutex; no notifier-local map.
- **[Risk] Stale allowlist keys after operator edits.** → **Mitigation**: D10 revalidation on registry load, clearing stale entries with a startup warn. No hot-reload in v1.
- **[Risk] Counter map grows unbounded across long coordinator lifetimes.** → **Mitigation**: counters live on the registry entry; entries have bounded cardinality (one per registered session). Re-registration of the same name with a new id resets counters for that id. No persistence.
- **[Risk] Debounce-on-failure masks recoverable tmux hiccups.** → **Mitigation**: accepted trade-off. Operators who suspect transient failures retry at the message level (the producer re-sends); the rate limit is per-recipient not per-message.
- **[Risk] `tmux display-message` itself can fail.** If the safety-gate probe fails (not just returns "unsafe"), we must choose fail-closed or fail-open. → **Mitigation**: fail-closed. Gate failure is treated as "unsafe" and emits `wake_suppressed { reason: "pane_state_unsafe" }`; the operator sees the issue via the suppression counter.
- **[Risk] `coordinator-client-cli` has not landed when this merges.** → **Mitigation**: D16. README fallback documents the raw MCP tool path.
- **[Trade-off] No cross-multiplexer support in v1.** → Accepted; `WakeBackend` interface accommodates future backends with zero dispatcher refactoring.
- **[Trade-off] `defaultCommand` preserved despite adding a tiny bit of config ceremony.** → Accepted; ergonomics win for launcher scripts, cost is one `.refine()` check.

## Migration Plan

- **Server-side**: the new config block is optional with no auto-wake behaviour when absent, so existing `mcp-config.json` files are forwards-compatible without edits. Operators opting in add a `peerBus.autoWake` block and restart the coordinator. The module split (extracting `wakeDispatcher` from `notifierTmux`) is a refactor of a single module pair and is invisible to existing consumers.
- **Session-side**: existing `register_session` calls that do not include `autoWakeKey` are unchanged — the field is optional. Back-compat guarantee: any registration from a pre-change client continues to work and behaves as opt-out. Registry entries loaded from a pre-change `registry.json` that lack `autoWakeKey` continue to work and are opted-out; no back-filling with defaults.
- **Rollback**: remove the `peerBus.autoWake` block from `mcp-config.json` and restart. Next startup revalidation logs a warn for every registered session that holds an `autoWakeKey` and clears the field (per D10). Any further `register_session` calls that carry `autoWakeKey` are rejected with `auto_wake_disabled`. No persistent state migration is required.

## Open Questions

- **Pane-current-command allowlist default set.** Shipping with `["claude", "bash", "zsh", "sh"]`. Fish and nushell users will need to add their shell. Worth a one-line note in the README recipe.
- **Should `wake_suppressed { reason: "pane_state_unsafe" }` include the detected `pane_current_command`?** Leaning yes — it is operator-useful for tuning `allowedPaneCommands`, and the detected command is already operator-visible via direct tmux inspection, so no new leak. Not load-bearing; implementer's call.
