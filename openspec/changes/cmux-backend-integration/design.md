## Context

The peer bus teaming system ships one backend for both the notifier (passive window decoration) and the auto-wake dispatcher (active keystroke injection): tmux. The `WakeBackend` interface in `src/core/wake-backend.ts` was explicitly designed to accommodate future non-tmux backends — it is already a clean interface boundary. The `notifier-tmux.ts` function is a thin standalone module. Both are straightforward to extend without touching the dispatcher, session registry, or MCP tool layer beyond a few targeted additions.

cmux is a native macOS terminal that auto-injects three environment variables into every pane: `CMUX_SURFACE_ID` (opaque surface identifier, format `surface:N`), `CMUX_WORKSPACE_ID`, and `CMUX_SOCKET_PATH`. Its CLI exposes `cmux send-surface`, `cmux send-key-surface`, `cmux notify`, and `cmux set_status`/`clear_status`. Critically, cmux does NOT expose a `pane_current_command` equivalent — the safety gate that checks whether the recipient pane is safe to inject keystrokes into cannot be implemented with current cmux APIs (upstream issues #152, #153).

Current state of each tmux touchpoint:

| Component | File | Status |
|-----------|------|--------|
| Passive notifier | `src/core/notifier-tmux.ts` | Needs cmux parallel |
| Wake backend | `src/core/wake-backends/tmux.ts` | Needs cmux parallel |
| Target validation | `src/core/peer-bus-constants.ts` (`SESSION_NAME_REGEX`) | Needs to move per-backend |
| Config schema | `src/config.ts` | Needs `backend` union + cmux notifier fields |
| Session registry | `src/core/session-registry.ts` | Needs `cmuxSurfaceId` field |
| `register_session` tool | `src/server/tools/peer-bus.ts` | Needs optional `surfaceId` param |
| Peer bus skill | `.claude/skills/peer-bus-session/SKILL.md` | Needs cmux env var detection |
| Docs | `docs/peer-bus-runbook.md`, `README.md` | Needs cmux recipes |

---

## Goals / Non-Goals

**Goals:**
- Passive notifier works in cmux panes (`cmux notify`, sidebar badge)
- Auto-wake is wired up but **deliberately disabled** (safety gate always returns `safe: false`) until cmux exposes pane process state
- Both tmux and cmux backends coexist; config selects which is active; existing tmux code is untouched
- `register_session` accepts `surfaceId` so the coordinator knows which cmux surface to target
- Target validation is moved into each backend, removing the shared `SESSION_NAME_REGEX` constraint that rejects `surface:N` IDs
- Peer-bus-session skill detects cmux context automatically

**Non-Goals:**
- A working pane-state probe for cmux (blocked on upstream)
- Dynamic backend switching at runtime (config-time selection only)
- Linux / Windows cmux support (cmux is macOS-only; tmux backend remains for those environments)
- cmux MCP server integration (separate concern)

---

## Decisions

### D1 — `isPaneStateSafe()` permanently returns `safe: false` in `CmuxWakeBackend`

**Decision:** The cmux backend's safety gate always returns `{ safe: false, currentCommand: "<probe_disabled>" }`. Auto-wake is therefore silently suppressed for all cmux recipients until the probe can be implemented.

**Rationale:** The probe exists to prevent Enter from auto-confirming a destructive interactive dialog (sudo, git commit editor, fzf). Without a reliable way to check the foreground process, the only safe options are "never dispatch" or "always dispatch regardless of pane state". Always-dispatch would silently remove the safety gate with no operator visibility. Never-dispatch with a documented TODO is honest and safe — operators see `wake_suppressed { reason: "pane_state_unsafe" }` in the audit log on every suppression, which makes the disabled probe observable.

**Alternatives considered:**
- *`cmux read-screen` heuristic* — parse terminal content looking for shell prompt patterns. Fragile: depends on prompt theme, shell config, scrollback state. A wrong `safe: true` on a sudo prompt is the exact harm case the gate was designed to prevent. Rejected.
- *Default `safe: true` with config flag* — operator opt-in to bypass the probe. Adds surface area; still removes the gate silently for most users. Rejected.

### D2 — Backend selection via `peerBus.backend: "tmux" | "cmux"` config union

**Decision:** The active backend is selected at coordinator startup from a new `peerBus.backend` config field (default `"tmux"` for backward compatibility). Both notifier and wake backend follow the same `backend` value — they are not independently selectable.

**Rationale:** Operators run one terminal, not two. Allowing notifier and wake to be configured independently adds cognitive overhead for no real benefit. A single `backend` field is clear and self-consistent. Default `"tmux"` means zero breaking changes for existing deployments.

**Alternatives considered:**
- *Separate `notifier.backend` and `autoWake.backend` fields* — more granular, unnecessary complexity. Rejected.
- *Auto-detect from env vars* (`CMUX_SOCKET_PATH` present → use cmux) — appealing but fragile: the coordinator process may not have cmux env vars set if started outside cmux, even when the panes it communicates with are running inside cmux. Config-explicit is unambiguous. Rejected.

### D3 — Target validation scoped to each backend; `SESSION_NAME_REGEX` is NOT renamed

**Decision:** `SESSION_NAME_REGEX` (`^[a-z0-9][a-z0-9-]{0,62}$`) in `peer-bus-constants.ts` is NOT renamed — it is the canonical session-name validator used by `SessionRegistry`, `TmuxWakeBackend`, and other modules. `TmuxWakeBackend` MAY define a module-scoped `TMUX_TARGET_REGEX` alias, but the canonical export is unchanged. A new module-scoped `CMUX_SURFACE_ID_REGEX = /^surface:\d+$/` is defined inside `src/core/wake-backends/cmux.ts`. The `WakeDispatcher` does not validate target format itself — that is a backend concern.

**Rationale:** Renaming `SESSION_NAME_REGEX` would be a breaking change to an exported symbol: `session-registry.ts` re-exports it and uses it for session-name validation (a distinct concept from tmux targets). Scoping the backend-specific regex to the backend module avoids a cross-cutting rename with no functional benefit.

### D4 — `cmuxSurfaceId` stored in registry; `wakeTarget` provides backend-agnostic dispatch target; cleared on load if malformed

**Decision:** `SessionRegistryEntry` gains an optional `cmuxSurfaceId?: string` field (stored plain text, not hashed — not a secret). A companion `wakeTarget?: string` field is computed from `cmuxSurfaceId` at registration time and during `load()`, and used by the dispatcher as `entry.wakeTarget ?? entry.name`. `cmuxSurfaceId` IS persisted to `registry.json` (needed for badge clear on read_messages after coordinator restart), BUT `load()` validates it against `CMUX_SURFACE_ID_REGEX` — malformed values are dropped with a warn. `wakeTarget` is NOT persisted; it is recomputed from `cmuxSurfaceId`. On re-registration, `cmuxSurfaceId` is always overwritten when a new string value is provided (never preserved), mitigating the surface ID reuse risk.

**Rationale:** The session `name` is the stable peer identity for message routing. `CMUX_SURFACE_ID` is an ephemeral addressing token. Keeping them separate means message routing is unaffected by the cmux surface lifecycle. `wakeTarget` decouples the dispatcher from backend-specific target formats without adding type-switch logic to the dispatcher.

| `backend` value | `peerBus.notifier.cmuxEnabled` | Effect |
|---|---|---|
| `"tmux"` | `false` | Existing tmux notifier off; tmux wake backend active |
| `"tmux"` | `true` | `cmuxEnabled` ignored; tmux notifier and wake backend active (same as `false`) |
| `"cmux"` | `false` | cmux wake backend active; cmux notifier OFF (no `cmux notify` calls, no badge) |
| `"cmux"` | `true` | cmux wake backend active AND cmux notifier active (full cmux teaming) |

### D5 — Notifier uses `cmux notify` (macOS notification) for messages; `cmux set_status`/`clear_status` for badge

**Decision:** `notifier-cmux.ts` calls `cmux notify --title "peer-bus" --body "<scrubbed-message>"` for new-message notification and `cmux set_status --surface <id>` / `cmux clear_status --surface <id>` for the unread badge (replacing tmux's `set-window-option window-status-style`).

**Rationale:** cmux's native notification system is the idiomatic replacement for tmux's status-bar decoration. The `cmux notify` call is fire-and-forget (same failure semantics as the tmux notifier — failure is logged as a warn, never propagated). `scrubForCmux()` strips control chars and newlines but does NOT need to strip tmux format-language characters (`#{}` etc.) — those are only dangerous in tmux argv.

### D6 — Both `COORDINATOR_SESSION_NAME` and `CMUX_SURFACE_ID` are required in cmux mode; skill validates session name

**Decision:** In cmux mode, BOTH env vars are required and serve distinct purposes:
- `COORDINATOR_SESSION_NAME` — stable human-readable peer identity (`claude-main` etc.), used as the registry key for message routing. Set by the operator in each cmux pane's startup profile (same as the tmux launcher did). The skill MUST validate the resolved name against `SESSION_NAME_REGEX` before use, and SHALL emit a visible error (not a silent stop) if it fails. If `CMUX_SURFACE_ID` is set but `COORDINATOR_SESSION_NAME` is unset, the skill SHALL print: `"peer-bus: cmux pane detected ($CMUX_SURFACE_ID set) but COORDINATOR_SESSION_NAME is unset — set it in your cmux pane profile to enable bus features"` and stop.
- `CMUX_SURFACE_ID` — ephemeral cmux-assigned surface identifier, passed as `surfaceId` to `register_session`. Set automatically by cmux; the operator does not need to configure it.

**Alternatives considered:**
- *Use `CMUX_WORKSPACE_ID` as pane identity* — workspace IDs appear to be opaque (not human-readable names). Unverified; treat as spike (OQ1). Rejected as primary approach until confirmed.

---

## Risks / Trade-offs

**Auto-wake silently suppressed** → Every cmux recipient with `autoWakeKey` will produce `wake_suppressed { reason: "probe_disabled" }` on every message (NOT `"pane_state_unsafe"` — the `"probe_disabled"` reason is normatively specified in the `peer-session-bus` spec). Operators can distinguish a disabled probe from a genuinely unsafe pane. Document in runbook.

**`CMUX_SURFACE_ID` is ephemeral** → If the recipient pane is closed and reopened, its `CMUX_SURFACE_ID` changes. The stored `cmuxSurfaceId` in the registry becomes stale; the next wake attempt fails silently. **Mitigation:** the peer-bus-session skill re-registers on every coordinator restart (recovery protocol in section 2), which updates `cmuxSurfaceId`. Stale IDs are only a problem if the pane is reopened mid-session without a coordinator restart. Document in runbook.

**`cmux` binary must be on PATH** → `notifier-cmux.ts` and `CmuxWakeBackend` both call `cmux` via `execFile`. If cmux is not installed or not on PATH, both silently fail (same semantics as ENOENT on the tmux binary). **Mitigation:** log a warn on ENOENT with "cmux binary not found — check PATH"; no retries.

**cmux is macOS-only** → Linux/CI environments cannot use the cmux backend. **Mitigation:** default backend is `"tmux"`, so existing deployments are unaffected. Document macOS-only constraint in README.

---

## Migration Plan

1. Existing deployments using `backend: "tmux"` (or no `backend` field, which defaults to `"tmux"`) are unaffected — zero changes to runtime behaviour.
2. cmux users set `peerBus.backend: "cmux"` in `mcp-config.json` and restart the coordinator.
3. Each Claude pane startup script (cmux workspace profile or `.envrc`) must set `COORDINATOR_SESSION_NAME=<pane-name>`. This is the same requirement as the tmux launcher — no new manual step beyond changing the terminal.
4. The `peer-bus-session` skill detects `$CMUX_SURFACE_ID` and passes it automatically; no operator action needed for surface ID registration.
5. No data migration — `registry.json` entries without `cmuxSurfaceId` load successfully and behave as opt-out for cmux wake.

**Rollback:** set `peerBus.backend: "tmux"` (or remove the field) and restart the coordinator. No registry migration needed.

---

## Open Questions

**OQ1 — RESOLVED** cmux injects only `CMUX_WORKSPACE_ID`, `CMUX_SURFACE_ID`, `TERM_PROGRAM`, and `TERM` into panes. No human-readable name env var exists. `COORDINATOR_SESSION_NAME` must be set manually in each pane's startup profile, or derived via `$(cmux current-workspace --json 2>/dev/null | jq -r '.title // empty')`. The skill documents this pattern. Not open.

**OQ2 — RESOLVED** `cmux send-surface` is text-only and does NOT interpret named key sequences (Enter, ctrl+c, etc.) — those are exclusively for `cmux send-key-surface`. However, cmux CLI does automatically unescape `\n` and `\t` in argv strings. Mitigation: add `\` (backslash, `\x5C`) to `AUTO_WAKE_ILLEGAL_BYTE` in `src/config.ts` so operator-authored allowlist values cannot contain escape sequences that cmux would convert to control chars. No literal-mode flag is needed or available. Not open.

**OQ3 — RESOLVED** `"probe_disabled"` is normatively specified in `specs/peer-session-bus/spec.md` as a required fourth `wake_suppressed` reason. The `WakeBackend.isPaneStateSafe` return type gains an optional `suppressReason` field; `CmuxWakeBackend` sets `suppressReason: "probe_disabled"`. Not open.

**OQ4 — RESOLVED (new finding)** `cmux set-status`/`clear-status` are key-based and workspace-scoped, not surface-scoped. The spec has been corrected: the badge key is `"peer-bus"` and calls require `--workspace <cmuxWorkspaceId>`. The registry stores both `cmuxSurfaceId` (for wake targeting) and `cmuxWorkspaceId` (for badge management). `register_session` accepts both `surfaceId` and `workspaceId` parameters. Not open.
