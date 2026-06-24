## 1. Constants

- [x] 1.1 Add `PROBE_DISABLED_SENTINEL = "<probe_disabled>"` to `src/core/peer-bus-constants.ts` (do NOT rename `SESSION_NAME_REGEX`)
- [x] 1.2 Add module-scoped `CMUX_SURFACE_ID_REGEX = /^surface:\d+$/` inside `src/core/wake-backends/cmux.ts`
- [x] 1.3 Add module-scoped `CMUX_WORKSPACE_ID_REGEX = /^workspace:\d+$/` inside `src/core/notifier-cmux.ts`
- [x] 1.4 Add `\` (backslash `\x5C`) to `AUTO_WAKE_ILLEGAL_BYTE` in `src/config.ts` — cmux CLI auto-unescapes `\n`/`\t` in argv; rejecting `\` in allowlist values prevents accidental newline injection
- [x] 1.5 Verify no existing imports of `SESSION_NAME_REGEX` break — it stays exported unchanged

## 2. Config schema

- [x] 2.1 Add `backend: z.enum(["tmux", "cmux"]).default("tmux")` to the `PeerBus` Zod schema in `src/config.ts`
- [x] 2.2 Add `cmuxEnabled: z.boolean().default(false)` to the `PeerBusNotifier` Zod schema
- [x] 2.3 Export a `PeerBusBackend` type alias (`"tmux" | "cmux"`) from `src/config.ts`
- [x] 2.4 Add config tests: absent `backend` defaults to `"tmux"`; `"cmux"` accepted; invalid value rejected; `cmuxEnabled` accepted

## 3. Session registry

- [x] 3.1 Add optional `cmuxSurfaceId?: string` and `cmuxWorkspaceId?: string` fields to `SessionRegistryEntry` in `src/core/session-registry.ts`
- [x] 3.2 Add optional `wakeTarget?: string` field (in-memory only, NOT persisted); set to `cmuxSurfaceId` whenever `cmuxSurfaceId` is written
- [x] 3.3 Persist both `cmuxSurfaceId` and `cmuxWorkspaceId` to `registry.json`
- [x] 3.4 In `load()`: validate `cmuxSurfaceId` against `CMUX_SURFACE_ID_REGEX` and `cmuxWorkspaceId` against `CMUX_WORKSPACE_ID_REGEX`; drop malformed values and emit `warn`; recompute `wakeTarget` from valid `cmuxSurfaceId`
- [x] 3.5 Add test: valid values survive load; malformed values are dropped with warn; absent values load successfully

## 4. `register_session` tool

- [x] 4.1 Add optional `surfaceId?: string | null` and `workspaceId?: string | null` to `register_session` tool schema (three-value semantics for both)
- [x] 4.2 Validate `surfaceId` against `CMUX_SURFACE_ID_REGEX`; validate `workspaceId` against `CMUX_WORKSPACE_ID_REGEX` (both: non-empty after trim, max 64 bytes); add `"surfaceId"` → `"invalid_surface_id"` and `"workspaceId"` → `"invalid_workspace_id"` cases to `mapRegisterZodError`
- [x] 4.3 When string: always overwrite stored value (never preserve); `surfaceId` also updates `wakeTarget`. When null: clear field. When absent: preserve existing
- [x] 4.4 Add test: string stores and overwrites; null clears; absent preserves; invalid format returns correct error code; success response shape unchanged (`{ name, sessionToken, registeredAt }`)

## 5. Wake dispatcher

- [x] 5.1 Update `WakeDispatcher.maybeDispatch` to use `entry.wakeTarget ?? entry.name` as the target passed to `backend.sendKeys` (not always `entry.name`)
- [x] 5.2 Add `suppressReason?: "probe_disabled" | "pane_state_unsafe"` to `WakeBackend.isPaneStateSafe` return type in `src/core/wake-backend.ts`
- [x] 5.3 In dispatcher: when `isPaneStateSafe` returns `safe: false`, use `probe.suppressReason ?? "pane_state_unsafe"` as the `wake_suppressed` reason
- [x] 5.4 Add `"probe_disabled"` to `SuppressReason` union in `src/core/wake-dispatcher.ts`
- [x] 5.5 Add dispatcher test: cmux backend with `suppressReason: "probe_disabled"` emits `wake_suppressed { reason: "probe_disabled" }`; tmux backend with no `suppressReason` still emits `"pane_state_unsafe"`

## 6. `CmuxWakeBackend`

- [x] 6.1 Create `src/core/wake-backends/cmux.ts` with `CmuxWakeBackend implements WakeBackend`
- [x] 6.2 Implement `isPaneStateSafe()` — always returns `{ safe: false, currentCommand: PROBE_DISABLED_SENTINEL, suppressReason: "probe_disabled" }` without any `execFile` call
- [x] 6.3 Implement `sendKeys(target, resolvedCommand)` — validate target with `CMUX_SURFACE_ID_REGEX`; validate non-empty command; call `execFile("cmux", ["send-surface", "--surface", target, resolvedCommand])` then `execFile("cmux", ["send-key-surface", "--surface", target, "enter"])`; propagate `failurePhase: "type"` / `"enter"` as appropriate; 5000 ms timeout on both

## 7. `notifier-cmux.ts`

- [x] 7.1 Create `src/core/notifier-cmux.ts` with `scrubForCmux(s: string): string` — strips C0 controls (`\x00–\x1F`), DEL (`\x7F`), and newlines; truncate to 256 UTF-8 bytes appending `…` if truncated
- [x] 7.2 Implement `fireCmuxNotifier(config, envelope)` — format body using `displayMessageFormat` template with `{from}` + `{kind}`; scrub; call `execFile("cmux", ["notify", "--title", "peer-bus", "--body", scrubbed])` with 5000 ms timeout; log warn "cmux binary not found — check PATH" on ENOENT; never propagate
- [x] 7.3 Implement `setCmuxBadge(workspaceId: string)` — validate against `CMUX_WORKSPACE_ID_REGEX` (warn + skip if fails); call `execFile("cmux", ["set-status", "peer-bus", "unread", "--workspace", workspaceId])`; fire-and-forget
- [x] 7.4 Implement `clearCmuxBadge(workspaceId: string)` — same validation; call `execFile("cmux", ["clear-status", "peer-bus", "--workspace", workspaceId])`; fire-and-forget

## 8. PeerBusContext notifier hook + badge state

- [x] 8.1 Add optional `notifier?: { clearCmuxBadge?: (workspaceId: string) => void }` to `PeerBusContext` in `src/server/tools/peer-bus.ts`
- [x] 8.2 Wire `clearCmuxBadge` in server startup when `backend: "cmux"`; pass through `PeerBusContext` to `read_messages` tool
- [x] 8.3 In `read_messages` tool: after successful read, call `context.notifier?.clearCmuxBadge?.(entry.cmuxWorkspaceId)` if `cmuxWorkspaceId` present
- [x] 8.4 In `send_message` post-delivery fan-out: track unread count per recipient; call `setCmuxBadge(entry.cmuxWorkspaceId)` only on empty→non-empty transition; call `fireCmuxNotifier` on every delivery

## 9. Backend wiring in server

- [x] 9.1 In `src/server/index.ts` (coordinator startup), instantiate `CmuxWakeBackend` or `TmuxWakeBackend` based on `config.peerBus.backend`
- [x] 9.2 In `send_message` fan-out, call `fireCmuxNotifier` or `fireTmuxNotifier` based on active backend
- [x] 9.3 Pass cmux notifier hooks through `PeerBusContext` when `backend: "cmux"`

## 10. Stable pane name (resolved spike)

- [x] 10.1 No cmux env var for human-readable name exists — `COORDINATOR_SESSION_NAME` must be set manually. Document in skill and runbook
- [x] 10.2 In skill: add pattern for cmux users: `export COORDINATOR_SESSION_NAME=$(cmux current-workspace --json 2>/dev/null | jq -r '.title // empty')` as the recommended startup script line

## 11. `cmux send-surface` literal mode (resolved spike)

- [x] 11.1 No literal-mode flag needed — `cmux send-surface` is text-only and does not interpret key-name sequences (those are `send-key-surface` only)
- [x] 11.2 Task 1.4 (backslash rejection in `AUTO_WAKE_ILLEGAL_BYTE`) is the mitigation for `\n`/`\t` escape sequence unescaping by cmux CLI — no changes needed to `scrubForCmux()` itself

## 12. Peer-bus-session skill

- [x] 12.1 Update `.claude/skills/peer-bus-session/SKILL.md` — detect cmux context: if `$CMUX_SURFACE_ID` and `$CMUX_SOCKET_PATH` are set, the pane is running in cmux
- [x] 12.2 If `CMUX_SURFACE_ID` set but `COORDINATOR_SESSION_NAME` unset: print actionable message `"peer-bus: cmux pane detected ($CMUX_SURFACE_ID set) but COORDINATOR_SESSION_NAME is unset — set it in your cmux pane profile to enable bus features"` and stop
- [x] 12.3 Pass `surfaceId: $CMUX_SURFACE_ID` and `workspaceId: $CMUX_WORKSPACE_ID` to `register_session` when in cmux context; pass `undefined` (omit both fields) on recovery re-registrations so stored values are preserved
- [x] 12.4 Update auto-activation description: skill activates when `$COORDINATOR_SESSION_NAME` is set (tmux launcher) OR when `$CMUX_SURFACE_ID` is set (cmux context)

## 13. Tests

- [x] 13.1 Create `tests/wake-backend-cmux.test.ts` — mock `child_process.execFile`; cover: `isPaneStateSafe` always returns `safe: false` with `suppressReason: "probe_disabled"`; valid `sendKeys` makes two calls with expected argv; invalid target format rejects without `execFile`; empty command rejects; `failurePhase: "type"` on first call failure; `failurePhase: "enter"` on second call failure
- [x] 13.2 Create `tests/notifier-cmux.test.ts` — cover: `scrubForCmux` strips control chars/newlines/truncates at 256 bytes; `fireCmuxNotifier` uses `displayMessageFormat` template and expected argv; ENOENT emits warn and does not throw; `setCmuxBadge` re-validates surface ID (warn+skip on invalid); `clearCmuxBadge` with expected argv; missing `cmuxSurfaceId` skips badge calls
- [x] 13.3 Add config tests to `tests/config.test.ts` for new `backend` and `cmuxEnabled` fields
- [x] 13.4 Add wake-dispatcher tests: `suppressReason: "probe_disabled"` emits correct reason; no `suppressReason` falls back to `"pane_state_unsafe"`; `wakeTarget` is used as dispatch target when present
- [x] 13.5 Add `register_session` tool tests: three-value semantics (absent preserves, null clears, string overwrites); invalid format returns `invalid_surface_id`; `mapRegisterZodError` maps `surfaceId` field to `"invalid_surface_id"`
- [x] 13.6 Add session-registry load tests: valid `cmuxSurfaceId` survives; malformed dropped with warn; absent loads successfully

## 14. Docs

- [x] 14.1 Update `docs/peer-bus-runbook.md` — add Section 2a: cmux setup (set `peerBus.backend: "cmux"`, `cmuxEnabled: true`, set `COORDINATOR_SESSION_NAME` in pane profile, `CMUX_SURFACE_ID` is auto-set); note auto-wake disabled with `probe_disabled` reason pending upstream fix; add kill-switch and recovery notes
- [x] 14.2 Update `README.md` — add cmux quick-start alongside tmux recipe; note macOS-only constraint; note auto-wake disabled status; document both env vars and their purposes

## 15. Full verification

- [x] 15.1 Run `npm run build && npm test` — all 111+ tests pass with zero regressions
