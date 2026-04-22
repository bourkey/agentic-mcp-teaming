## Context

The `peer-session-bus` change added three MCP tools (`register_session`, `send_message`, `read_messages`). The `coordinator-serve-mode` change gave the server a long-running lifecycle. Neither addressed the **client side**: every consuming project still has to build its own token-cache, recovery, and envelope-handling layer. That duplicates work and implicitly ties the bus to Claude Code's hook API.

The user has also asked for token-usage metrics — informational only, self-reported, not used for decisions or budgets. The two concerns land well together because the metrics payload is just one more tool call that shares the same auth, cache, and recovery path as every other client operation.

This change turns the `coordinator` binary into a dual-role server+client. Downstream projects adopt the bus by invoking `coordinator ...` subcommands from whatever runtime they already use (Claude Code hooks, Codex, Python scripts, shell).

Constraints carried forward:
- `execFile`-only for subprocess invocations (not relevant to the client CLI itself, but the guidance applies anywhere we shell out).
- Session token NEVER logged, never returned after first registration.
- Compile-time caps from `peer-session-bus` still apply server-side.
- `Map<string, Entry>` registry resists prototype pollution.

## Goals / Non-Goals

**Goals:**
- The `coordinator` binary exposes client subcommands (`register`, `send`, `read`, `report-tokens`, `deregister`) that handle auth, token cache, and stale-token recovery transparently.
- Consumers integrate the bus with shell invocations — no bespoke token management, no re-implementation of recovery logic.
- Server gains a `report_tokens` tool and a `metrics.jsonl` file for delta-style token usage reports.
- In-memory aggregates per session are reconstructable from `metrics.jsonl` at startup.
- Zero backwards-incompatible changes: existing `serve`/`start`/`status` and peer-bus config unchanged.

**Non-Goals:**
- Cost calculation or price-table maintenance. Consumers compute dollars from raw tokens.
- Budget enforcement or any decision-driving use of metrics. Strictly informational.
- A scaffolding subcommand that generates integration boilerplate. Reference docs first; scaffold later when we have 2+ real consumers.
- A `get_metrics` MCP tool. `tail -f metrics.jsonl | jq` is sufficient for v1.
- Verification of reported token counts. Self-reported and trusted at face value per the user's call.
- A `deregister_session` MCP tool. Local cache cleanup is enough; stale registry entries are tolerated (same as for any dead pane in v1).
- Token-reporting integration with any specific agent CLI (Claude, Codex, etc.). Consumers decide where they source token counts from; the subcommand just takes integers.

## Decisions

### D1 — Client subcommands live on the same `coordinator` binary

Not a separate npm package, not a separate process, not a separate entry point. Adding them to the existing Commander program means one install gives operators both the server and the client. Node binary size stays comparable (Commander + our handlers, no transitive bloat).

**Alternative considered**: ship a `@sysdig/peer-bus-client` npm package. Rejected — doubles the release pipeline, forces version-skew management between client and server, and offers no real benefit for a codebase this small.

### D2 — Subcommands share state via a token-cache file, not process state

Each authenticated subcommand reads `sessionToken` from `$XDG_RUNTIME_DIR/coordinator/<name>.token` at invocation time and writes it on rotation. This lets one shell process invoke `coordinator register` and a completely different process later invoke `coordinator send` without passing the token explicitly. That matches the hook model in Claude Code (each hook is a separate subprocess) and every other scripting context.

**File format**: `{ name, coordinatorUrl, sessionToken, registeredAt, writtenBy: <pid> }`, mode 0o600, owner-only readable. The `writtenBy` PID is diagnostic; the cache does NOT enforce PID ownership (multiple processes for the same session name may legitimately share it).

**Location precedence**:
1. `$XDG_RUNTIME_DIR/coordinator/<name>.token` if `XDG_RUNTIME_DIR` is set
2. `$TMPDIR/coordinator/<name>.token` if `TMPDIR` is set
3. `/tmp/coordinator/<name>.token` fallback

The directory is created with mode 0o700 on first write. On macOS (where XDG isn't standard), `$TMPDIR` is always set by the system, so the effective path is something like `/var/folders/xx/.../T/coordinator/<name>.token`.

**Alternatives considered**:
- Keychain / macOS Secrets. Overkill for a local-loopback token that expires on restart.
- Environment variable (`COORDINATOR_SESSION_TOKEN`) passed between processes. Works for some hook shapes but not across disjoint invocations (two independent hooks in the same pane can't share env easily).

### D3 — Recovery protocol implemented once, in `src/client/recovery.ts`

Every authenticated subcommand wraps its MCP call in a single helper:

```ts
recoverableCall(async (token) => callTool(name, args, token))
```

`recoverableCall` retries once on `invalid_session_token` after calling `register_session` (no `priorSessionToken`) to rotate. Rotations go back to the cache file atomically (`<file>.tmp` + rename). A second failure surfaces on stderr with a clear "operator intervention required" message and exits non-zero.

This is the protocol codified in the `peer-session-bus` spec ("Client recovery protocol on invalid_session_token"). By implementing it once, every subcommand inherits correctness.

### D4 — Metrics are delta-only, self-reported, not validated

Consumers maintain their own cumulative counter. On each `report-tokens` call they send the delta since their last report. The coordinator:
- Trusts the values.
- Appends `{ session, delta, model, timestamp }` to `metrics.jsonl`.
- Updates the in-memory aggregate on the registry entry (`aggregate.input += delta.input`, etc).

No verification against any external source. No reasonableness checks (a negative delta is rejected at Zod — but a wildly-large one is accepted). Documented as self-reported, informational-only.

**Alternative considered**: have the coordinator observe message sizes and tool-call counts as a proxy for activity. Rejected — token counts are the thing operators want, and the coordinator has no way to see them without model-API introspection.

### D5 — One JSONL-append abstraction shared between messages and metrics

`MessageStore` and `MetricsStore` both do the same thing: append JSON objects to a file, fsync, and load with tolerance for corrupt lines. Extract the common logic into a `JsonlAppendStore<T>` generic and let both be thin instantiations. Optional refactor within this change — if it starts pulling in unrelated cleanup, we stop and defer.

### D6 — Server-side `report_tokens` tool mirrors `send_message` shape

Same pattern for auth (caller identity derived from `sessionToken` via constant-time `authenticate`), same audit-log redaction (the delta object has no tokens or body so no hashing needed — logged as-is), same per-session mutex (so concurrent reports don't race the aggregate).

The tool does NOT append to `messages.jsonl`; it appends to `metrics.jsonl`. That separation keeps message-reconciliation logic unchanged.

### D7 — Config: `peerBus.metrics.enabled` defaults to `true` when `peerBus.enabled: true`

If peer-bus is on, metrics default on. Operators who specifically don't want the `report_tokens` tool registered can set `peerBus.metrics.enabled: false`. That removes the tool from the registry and skips metrics-store initialisation; no `metrics.jsonl` is created.

**Alternative considered**: default off. Rejected — metrics are lightweight, informational, and the whole motivation for this change includes them. Opt-out is right default here.

### D8 — `--wrap-for-prompt` is the Claude-Code-friendly read shape; JSON is the generic shape

`coordinator read` default output is a JSON array that's easy to parse from any language. `--wrap-for-prompt` is a convenience shape for Claude Code's `UserPromptSubmit` hook — the output is already a `<peer-inbox>…</peer-inbox>` block ready to prepend to a prompt. The two shapes are functionally equivalent; consumers pick the one that fits their integration.

### D9 — Integration guide in README over scaffolding tool for v1

A "Getting started as a consumer" section in the README walks a new project through:
1. Put `coordinator` on PATH
2. Set `COORDINATOR_URL`, `COORDINATOR_SESSION_NAME`, `COORDINATOR_AUTH_TOKEN`
3. Call `coordinator register` in the launcher
4. Call `coordinator send/read/report-tokens` from whatever hook/skill system the project uses

Two worked examples: Claude Code hooks + a generic shell script. No scaffolding binary until a second real consumer exists and we know what the actual template should look like.

## Risks / Trade-offs

- **Risk**: token cache file collisions if two processes on the same host use the same `COORDINATOR_SESSION_NAME`.
  **Mitigation**: document the 1-session-name-per-identity rule. The coordinator-side `priorSessionToken` check already prevents two live tokens for the same name, so the second registration's rotation invalidates the first. Operators running multiple tenants use distinct names.

- **Risk**: self-reported metrics drift from reality (wrong counter, lost updates, clock skew).
  **Mitigation**: accepted. Informational only. Document.

- **Risk**: the client CLI becomes a soft dependency for many downstream projects; version drift between the coordinator server and client CLI could break behaviour.
  **Mitigation**: ship them as one binary so they're always version-matched. Document that consumers using a pinned `coordinator` version should update in lockstep.

- **Risk**: token cache file in `$TMPDIR` may be wiped on reboot or by aggressive cleanup tools. Consumers then see `invalid_session_token` on next call and re-register automatically via the recovery protocol — graceful.
  **Mitigation**: already handled. Document.

- **Risk**: a consuming project misconfigures and writes arbitrary content to the cache file (hand-edited, corrupt).
  **Mitigation**: the cache reader validates JSON shape and fails loudly; recovery protocol re-registers. No auto-repair.

- **Trade-off**: the client CLI assumes HTTP/SSE transport (the only one the coordinator exposes today). If we ever add another transport, the client gets a config option. Not worth abstracting now.

- **Trade-off**: subcommand naming is slightly clunky (`coordinator register` isn't `coordinator register-session`). Short forms win for daily use; the long forms exist in the README as aliases if we ever want them.

## Migration Plan

Additive. Rollout:

1. Merge this change. Existing `serve`/`start`/`status` unchanged. Existing `peerBus` config unchanged. Existing clients (Claude Code panes, MCP Inspector) continue to work against the MCP tools directly.
2. Consumers opt into the CLI path by calling `coordinator register` in their launcher; everything after that uses the subcommands. There's no migration step for existing deployments because there ARE no existing deployments using the bus — this is all greenfield.
3. The sysdig-pov-docs companion proposal gets rewritten against the new client CLI surface (much smaller than its prior draft).

Rollback: remove the subcommands from the CLI. Server-side `report_tokens` tool and `metrics.jsonl` can be left in place harmlessly — they're only touched when called.

## Open Questions

None outstanding. The two calls the user made in chat —
- "informational, not budgetary or decision driven" → D4
- "extensible, not just for sysdig-pov-docs" → D1–D3 and D9
— close every question the earlier drafts left open. The shape above is the proposal.
