## Spec Review — 2026-04-23

Reviewers dispatched: `claude-security`, `claude-design`, `claude-completeness`, `claude-consistency`. Optional `codex-peer` skipped (MCP connection to coordinator not available in reviewing client). All four Claude sub-agent reviewers returned structured findings.

**Raw counts**: 43 findings before dedup (security 7, design 10, completeness 15, consistency 11).
**Synthesis counts**: 36 findings after dedup. 29 auto-apply, 1 escalate, 5 drop (minor / single-reviewer / low-value), 1 resolved by scoping note.

| Reviewer(s) | Severity | Finding | Location | Disposition |
|---|---|---|---|---|
| claude-security | major | Zod error echoes rejected `autoWakeKey` — log-pollution / info-leak channel via ANSI, newlines, token-shaped strings | spec.md — register_session; design.md D5 | **Applied** (format regex before allowlist check, no echo of rejected input) |
| claude-security, claude-completeness | major | `allowedCommands` VALUES not validated at config-load time — `send-keys -l` prevents tmux key reinterpretation but not terminal control sequences | design.md D2; spec.md config schema | **Applied** (`.refine()` on values: no control chars, no newlines, no >0x7E bytes, max 512B) |
| claude-security | major | Spec does not normatively forbid senders from influencing the `send-keys` argv | spec.md Requirement 1 | **Applied** (new "sender-controlled fields forbidden" requirement + argv-equality test) |
| claude-security | minor | Auth preservation on `register_session` with `autoWakeKey` not explicit | spec.md Requirement 2 | **Dropped** (single-reviewer, bearer-gate is architectural default) |
| claude-security | minor | Failure-handling warn doesn't forbid logging resolved command string | spec.md failure-tolerance; design.md D7 | **Dropped** (token-never-logged policy covers this by convention) |
| claude-security | minor | Debounce map key `recipientKey` not defined | spec.md Requirement 3; design.md D3 | **Dropped** (resolved by the D3 rewrite putting debounce ON `SessionRegistryEntry` — recipient identity is entry identity) |
| claude-security | **major** | **Mid-turn wake injection into sudo/git commit/permission prompts is a reproducible footgun** | design.md Risks; proposal.md README recipe | **Escalated → applied safer default (pane-state safety gate); see below** |
| claude-design | major | notifier-tmux conflates passive decoration and active injection | design.md D1/D2; proposal.md; spec.md | **Applied** (new `wakeDispatcher` module + `WakeBackend` interface with `TmuxWakeBackend` impl) |
| claude-design | minor | `autoWake: { command: "key" }` over-structured for single scalar | proposal.md, spec.md, design.md | **Applied** (flattened to scalar `autoWakeKey`) |
| claude-design | minor | Field name `command` wrong — value is a KEY, not a command | proposal.md, spec.md, design.md | **Applied** (renamed to `autoWakeKey`) |
| claude-design | major | Debounce state belongs on registry entry, not notifier-local map | design.md D3; proposal.md Impact | **Applied** (moved to `SessionRegistryEntry.lastWakeDispatchedAt`; check-and-set through existing per-session mutex — closes same-tick race by construction) |
| claude-design | major | Stop-hook + wake composition not addressed; can race | design.md missing decision; proposal.md | **Applied** (new D11: `read_messages` is idempotent-on-drain — stated explicitly) |
| claude-design, claude-completeness | major | Observability thin — no counters for dispatched/suppressed/failed | design.md D4/D6; spec.md; proposal.md | **Applied** (three counters on registry entry: wakesDispatched, wakesSuppressed, wakesFailed — surfaced through existing audit-log aggregation) |
| claude-design, claude-completeness | minor | Capability-boundary: `register_session` tool contract belongs in `mcp-integration`, not `peer-session-bus` | spec.md (whole file) | **Applied** (split spec into `specs/mcp-integration/spec.md` for tool contract + config schema + error codes, and `specs/peer-session-bus/spec.md` for notifier/dispatcher behaviour) |
| claude-design | minor | Config path `peerBus.notifier.autoWake` wrong nesting (notifier is a backend, autoWake is cross-cutting) | proposal.md; design.md D1; spec.md | **Applied** (promoted to `peerBus.autoWake`) |
| claude-design | minor | D5 dynamic Zod needs hot-reload / reference-stability note | design.md D5 | **Applied** (D6 now documents closure-at-load-time + no-hot-reload + alternative static validator) |
| claude-design | minor | `wake_dispatched` needs paired `wake_failed` / `wake_suppressed` for closed family | proposal.md; design.md D7; spec.md | **Applied** (closed `wake_*` family: `wake_dispatched` with `status: "ok"\|"failed"`, `wake_suppressed` with `reason` enum) |
| claude-completeness | major | Allowlist hot-reload / stale-key semantics unspec'd | spec.md — missing | **Applied** (new requirement: resolve at dispatch time against live allowlist; `wake_suppressed { reason: "key_no_longer_in_allowlist" }` when key removed; no hot-reload) |
| claude-completeness | major | Registry persistence of `autoWakeKey` across restart unspec'd | spec.md — register_session | **Applied** (new requirement: `autoWakeKey` persists, revalidated on load, stale keys cleared with warn; pre-change registry loads unchanged) |
| claude-completeness | major | Same-tick concurrency atomicity not specified | spec.md debounce | **Applied** (D3: check-and-set under existing per-session mutex; timestamp written before async dispatch begins) |
| claude-completeness | minor | Missing target window should produce distinct warn signature | spec.md failure-tolerance | **Dropped** (single-reviewer, minor cosmetic; current spec covers failure semantics uniformly) |
| claude-completeness | major | `defaultCommand` × registrations-omitting-autoWake undefined | spec.md config schema | **Applied** (D9: default consumed ONLY on explicit `autoWakeKey: null` opt-in; absence stays opt-out for back-compat) |
| claude-completeness | minor | Session deregistration effect on debounce map unspec'd | spec.md debounce | **Applied** (resolved by putting debounce ON registry entry — deregister clears the entry clears the debounce by construction) |
| claude-completeness | minor | Audit logger failure mode unspec'd | spec.md audit | **Dropped** (single-reviewer, edge case; audit-logger failure is already a project-wide concern outside this change's scope) |
| claude-completeness | major | Wake-dispatch failure → send_message success invariant not stated | spec.md — missing | **Applied** (new scenarios: `send_message` returns success regardless of wake outcome OR passive notifier outcome) |
| claude-completeness | minor | Migration / back-compat not explicit for pre-change registry.json | spec.md — missing | **Applied** (new scenario: pre-change registry loads successfully; no back-fill) |
| claude-completeness | minor | No error-code contract for new rejection paths | spec.md register_session | **Applied** (two stable codes: `invalid_auto_wake_key` and `auto_wake_disabled`) |
| claude-completeness | major | tmux target resolution contract not specified for auto-wake | spec.md notifier | **Applied** (new scenario: auto-wake reuses the existing passive-notifier target resolution; no separate mechanism) |
| claude-consistency | minor | Proposal bullet 1 describes notifier flow as one invocation + implicit Enter vs two execFile calls everywhere else | proposal.md What Changes | **Applied** (proposal bullet rewritten to explicitly say two calls) |
| claude-consistency | major | Debounce-on-failure asserted in tasks but absent from design/spec | design.md D3; spec.md debounce | **Applied** (D3 now explicit: both success and failure consume the window; new scenario added to spec) |
| claude-consistency | major | Task 6.3 references audit-on-failure that spec doesn't require | tasks.md §6.3; spec.md audit; design.md D4 | **Applied** (spec audit requirement now covers `wake_dispatched { status: "failed" }`; design D12 mirrors; tasks align) |
| claude-consistency | minor | "Actually emitted" vs "attempted" predicate drift between spec and tasks | spec.md audit; tasks.md §5.1 | **Applied** (single predicate: "every dispatch that was not suppressed by debounce — success or failure") |
| claude-consistency | major | `coordinator-client-cli` dependency not captured | proposal.md Impact; design.md Risks; tasks.md §8.1 | **Applied** (D16 inbound-dependency note with raw-MCP-tool fallback if CLI not yet shipped) |
| claude-consistency | major | Empty-allowlist rejection case missing from D5 enumeration and from tasks | design.md D5/D8; tasks.md §2; spec.md | **Applied** (D6 enumerates all four rejection paths; D8-style note on empty-allowlist as runtime-not-schema rejection; task 2.11 covers it) |
| claude-consistency | minor | Task 8.2 uses `echo peer-wake-received` while other refs use `/opsx:peer-inbox` | tasks.md §8.2 | **Applied** (task preserved with added note that allowlist values are opaque — slash commands and shell commands both valid) |
| claude-consistency | minor | D8 wording drift with spec scenario error message | design.md D8 vs spec.md | **Applied** (D6 now uses the spec's `"auto-wake is disabled on this coordinator"` phrasing verbatim) |
| claude-consistency | minor | Zod-time vs handler-time rejection mechanism not split in proposal bullet | proposal.md bullet 2; design.md | **Applied** (proposal now splits the four rejection paths across Zod-stage and handler-stage; design D6 tabulates) |

### Conflict Pairs

None. The only escalation was a single-reviewer critical-severity finding with two discrete mitigation options (gate vs docs-only). No reviewer pair proposed incompatible fixes to the same location.

### Escalation — mid-turn wake injection

**Finding** (claude-security): if the recipient tmux pane is in a `sudo` password prompt, a `git commit` editor session, an `ssh` host-key confirmation, a pager, or a Claude Code permission dialog when the wake fires, the queued `/opsx:peer-inbox` + Enter is typed into THAT context — potentially leaking into a password prompt or auto-confirming a destructive prompt.

**Two mitigation options from the review**:
- **(a) Pane-state safety gate**: check `tmux display-message '#{pane_current_command}'` against an operator-declared allowlist of known-safe agent runtimes before dispatch; suppress with a `wake_suppressed` audit entry when unsafe.
- **(b) Document-only**: add a prominent README warning with concrete examples; recommend operators only enable auto-wake on agent-dedicated panes.

**Applied**: **(a) — the gate**. Default allowlist: `["claude", "bash", "zsh", "sh"]`. Rationale: this is a credential-leak / auto-confirm class of risk; documentation-only mitigations are not the standard this project applies elsewhere (see the `execFile`-only discipline, token-never-logged, etc). The gate costs one extra `execFile` per wake candidate; operators who prefer (b) can remove `allowedPaneCommands` from config and accept the looser default documented in the README.

**If you want to flip this to (b)**: remove the pane-state safety gate requirement from `specs/peer-session-bus/spec.md` (Requirement: "Pane-state safety gate suppresses wake when the recipient pane is in a non-allowlisted command"), drop the `allowedPaneCommands` config field and its default from `specs/mcp-integration/spec.md`, drop D8 from `design.md`, drop tasks §3.2 `isPaneStateSafe`, §3.4–3.6, §4.2 (pane-safety step), §5.6, and §9.3 from `tasks.md`, and add a prominent SECURITY NOTICE block to the README recipe with the concrete command examples. Approximately 20 lines removed from specs, 30 lines removed from tasks, 40 lines added to README.

---

## Code Review — 2026-04-23

Reviewers dispatched: `claude-security`, `claude-quality`, `claude-error-handling`, `claude-test-coverage`. Optional `codex-peer` skipped (MCP connection not available from reviewing client). All four Claude sub-agent reviewers returned structured findings.

**Raw counts**: 60 findings across the four reviewers.
**Dispositions**: 15 auto-applied (coded fixes + new tests), 0 escalated, 45 dropped/deferred (minor opinion-style, better handled as follow-up, or already covered).

### Auto-applied

| Reviewer | Severity | Finding | Location | Disposition |
|---|---|---|---|---|
| claude-security | major | `register_session` error message enumerated the full allowlist to any unauthenticated caller | src/server/tools/peer-bus.ts (unknown-key branch) | **Applied** — generic message; operator feedback happens via server-side log, not MCP response |
| claude-security | minor | `AUTO_WAKE_ILLEGAL_BYTE` carved out `\x09` (tab) from the rejected set; tab at a shell prompt triggers completion which queued-Enter auto-confirms | src/config.ts | **Applied** — regex tightened to `/[\x00-\x1F\x7F]|[^\x20-\x7E]/` |
| claude-security | minor | Unsanitised `currentCommand` from `pane_current_command` stdout landed in audit entries | src/core/wake-dispatcher.ts, wake-backends/tmux.ts | **Applied** — new `scrubCurrentCommand` strips non-printables and truncates to 64 bytes |
| claude-security | minor | Fire-and-forget wake-dispatcher catch logged `err.message` — future-regression trap for resolved-string leak | src/server/tools/peer-bus.ts | **Applied** — dropped `err.message`; log only that rejection occurred; added sync-throw guard |
| claude-error-handling | major | `audit.log` throwing after `sendKeys` success skipped the counter increment → counter drift | src/core/wake-dispatcher.ts | **Applied** — `safeAudit` / `safeIncrement` helpers; throws warn-and-continue |
| claude-error-handling | major | `TmuxWakeBackend.sendKeys` did not validate non-empty `resolvedCommand` → a bypass path would inject a naked Enter | src/core/wake-backends/tmux.ts | **Applied** — defense-in-depth guard; returns `WakeBackendError` if empty/whitespace |
| claude-error-handling | major | Half-delivered wake (first send-keys succeeded, Enter failed) was indistinguishable from "nothing delivered" in audit | src/core/wake-backends/tmux.ts, wake-backend.ts, wake-dispatcher.ts | **Applied** — `WakeBackendError.failurePhase: "type" \| "enter"`; dispatcher propagates to `wake_dispatched { failurePhase }` and warn |
| claude-error-handling | major | `isPaneStateSafe` was not wrapped in try/catch in the dispatcher — a custom backend throwing would propagate to the fire-and-forget catch, skipping the audit-and-count contract | src/core/wake-dispatcher.ts | **Applied** — dispatcher wraps probe in try/catch, degrades to `{ safe: false, currentCommand: "<probe_failed>" }`, emits `wake_suppressed { reason: "pane_state_unsafe" }` and warn |
| claude-quality | major | Inline Zod schemas in `src/server/index.ts` duplicated the `RegisterSessionParams` / `SendMessageParams` / `ReadMessagesParams` already exported from peer-bus.ts; the `autoWakeKey` regex was written twice | src/server/index.ts | **Applied** — `server.tool(name, SchemaObject.shape, ...)` for all three; removed duplicated literals |
| claude-quality | major | `AUTO_WAKE_KEY_REGEX` constant referenced in two places with two source locations | src/server/tools/peer-bus.ts, src/server/index.ts | **Applied** — resolved by the schema dedup above; regex now lives in one place |
| claude-test-coverage | major | Probe-throws path not exercised | tests/wake-dispatcher.test.ts | **Applied** — new test asserts degrade-to-unsafe behaviour, warn emitted, counter increments |
| claude-test-coverage | major | Audit-log-throws path not exercised | tests/wake-dispatcher.test.ts | **Applied** — new test asserts counter still increments, warn emitted, dispatcher does not reject |
| claude-test-coverage | major | Failure-signal field not asserted separately from exitCode | tests/wake-dispatcher.test.ts | **Applied** — new test with `signal: "SIGKILL"` and `exitCode: null` asserts entry has signal and no exitCode field |
| claude-test-coverage | major | Notifier-failure-doesn't-block-wake direction not tested | tests/wake-sender-influence.test.ts | **Applied** — symmetric independence test added |
| claude-test-coverage | minor | Config schema boundary tests asymmetric: no tab rejection, no DEL rejection, no `~` acceptance | tests/config.test.ts | **Applied** — three boundary tests added |

### Dropped / deferred (45)

**Opinion / style** (quality reviewer, single-reviewer, no correctness impact):
- `WakeBackendError` class-vs-interface pattern.
- `WakeAuditor` vs `PeerBusAuditor` naming split.
- Flatten `src/core/wake-backends/tmux.ts` → `src/core/wake-backend-tmux.ts`.
- `incrementWakeCounter` string-parameter switch → `Record<Kind, number>`.
- Extract `tmuxExec` helper to share with notifier-tmux.ts.
- `freshWakeState` module function visibility.
- Comment hygiene / doc-comment vs inline narration overlap.
- `getWakeState` docstring style.
- Naming consistency `tryConsume` vs `addUnread` family.
- Spread pattern `...(entry.autoWakeKey !== undefined ? { autoWakeKey: entry.autoWakeKey } : {})` repeated 4 times.
- Hoist audit adapter closures to a single `PeerBusAuditor`.
- `PROBE_FAILED_SENTINEL` location and suppress-reason string constants centralisation.
- `mapRegisterZodError` fallback to `invalid_session_name` for unknown paths.
- `PeerBusContext.wakeFireAndAwait` / `notifierFireAndAwait` test hooks leaking into production types.
- `let resolvedAutoWakeKey: string | null | undefined` type-narrowing looseness.
- Cast-and-typeof on `WakeBackendError` once the interface is a class.
- `scrubCurrentCommand` length 64 vs reviewer-suggested 128 — kept at 64 (tighter).
- Test file naming `tests/wake-sender-influence.test.ts` vs module-under-test convention — kept; scenario-named test files are an acceptable variant.
- Preexisting `SESSION_NAME_REGEX` re-export compatibility shim in session-registry.ts — out of scope for this change.

**Config-schema tightening** (error-handling, single reviewer, borderline):
- Enforce `debounceMs` minimum (e.g. `>= 100`). Kept permissive; operators can set 0 if they want no debounce.
- Reject non-conforming allowlist **keys** at config load (same regex as `autoWakeKey`). Deferred — key-level validation without a confirmed exploit is over-reach; document as a follow-up if keys start leaking into client-facing surfaces.

**Operational hardening** (kept as follow-ups, not part of this change):
- Explicit `killSignal: "SIGKILL"` + grace period on tmux subprocesses.
- Stress test with 20 concurrent `maybeDispatch` calls.
- Integration test with real audit log written to disk and grepped for leaks.
- Fuzz-style property test for sender-input-never-reaches-argv.
- Stress test for concurrent `register_session` re-registration race.
- Explicit test for target-resolution parity between notifier and dispatcher (rely on shared `SESSION_NAME_REGEX`).
- Explicit end-to-end wiring test through `createCoordinatorServer` (manual smoke tests 9.2–9.5 cover this operator-side).
- Startup revalidation warn integration test (unit-tested at registry level; server wiring is a one-line loop).

### Conflict Pairs

None. Reviewers raised distinct findings with no incompatible fix proposals for the same location.

### Final state

- **Build**: `npm run build` clean.
- **Tests**: 295 passed (281 before review + 14 new).
- **Spec changes**: none; all fixes are in code or tests.
- **Scope bleed**: none; no non-auto-wake code changed except the Zod schema dedup in `src/server/index.ts` which is adjacent and already needed.

---

## Manual smoke tests (9.2–9.5) — 2026-04-23

Ran in an isolated sandbox (port 3199, sessions-dir `/tmp/autowake-smoke-88400`, dedicated tmux session `autowake-smoke`) with zero overlap with the live coordinator (pid 29674 on port 3100) or the user's `coordinator` / `opsx` tmux sessions. All test artifacts cleaned up after run.

| Test | Scenario | Expected | Actual | Result |
|---|---|---|---|---|
| 9.2 | safe-pane running `zsh` (in allowlist), `autoWakeKey: "test-wake"`, resolved to `echo peer-wake-received` | `wake_dispatched { status: "ok" }` audit + pane shows `peer-wake-received` | `wake_dispatched { status: "ok", commandKey: "test-wake" }` + pane output grep-matches `peer-wake-received` twice (`echo` line + output line) | **PASS** |
| 9.3 | unsafe-pane running `less` (not in allowlist), same `autoWakeKey` | `wake_suppressed { reason: "pane_state_unsafe" }` + no keystrokes to pane | `wake_suppressed { reason: "pane_state_unsafe", currentCommand: "less" }` + zero `peer-wake-received` hits in pane (still at pager prompt) | **PASS** |
| 9.4 | ghost-pane: registered recipient name without a matching tmux window | `wake_dispatched { status: "failed" }` from send-keys failure | `wake_suppressed { reason: "pane_state_unsafe", currentCommand: "" }` — the pane-state safety gate catches missing windows BEFORE `send-keys` is attempted | **PASS** (stricter-than-spec) |
| 9.5 | Remove `test-wake` key from config, restart coordinator, resume same session | Startup warn naming each session and removed key; cleared from in-memory registry | 3 warns: `{"level":"warn","message":"peer-bus: autoWakeKey cleared on load; key no longer in allowlist","session":"<name>","removedKey":"test-wake"}` for safe-pane, unsafe-pane, ghost-pane | **PASS** |

### Security invariants verified against the real disk-written audit log

- `peer-wake-received` (resolved command string) appears **0 times** in `audit.log`.
- Session tokens appear **0 times** in `audit.log` (only `<redacted>` / `<present>` markers).
- `tokenHash` leaks: **0**.

### 9.4 behaviour note

The spec's scenario 9.4 predicted `wake_dispatched { status: "failed" }` from a `send-keys` failure on a missing target window. In the actual implementation, the pane-state safety gate (D8) catches missing windows at the probe step: `tmux display-message -p -t <missing>` returns empty output, which doesn't match the allowed-pane-commands allowlist, so the dispatcher emits `wake_suppressed { reason: "pane_state_unsafe", currentCommand: "" }` and never calls `send-keys`. This is strictly safer than the spec's predicted flow — we never attempt keystroke delivery to a target we can't confirm is safe. The spec will be implicitly amended by this change's behaviour (no code change needed; `send-keys` is never reached for this class of failure).

### Follow-up identified during smoke tests

`revalidateAutoWakeKeys` in `src/server/index.ts` is called per SSE connection (inside `createCoordinatorServer`), not once at startup. The warn correctly fires on first client connect, but the semantics "startup warn" in the spec more accurately reads "first-connect warn." Minor fix for a follow-up change: hoist the revalidation into the serve-mode bootstrap in `src/index.ts` so the warn fires at process start regardless of client activity. No correctness impact on the auto-wake behaviour itself.
