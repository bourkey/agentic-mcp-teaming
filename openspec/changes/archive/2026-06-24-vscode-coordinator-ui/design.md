## Context

The coordinator is a Node.js CLI process that exposes an MCP server on `127.0.0.1:3100` and writes a NDJSON audit log to `sessions/<id>/audit.log`. All workflow state is in `sessions/<id>/state.json`. The extension has two clean integration points: the audit log file (for streaming live events) and the MCP HTTP API (for issuing `resolve_checkpoint` calls). No coordinator source changes are needed for a v1 that stays within the currently persisted data.

VS Code extensions run in a sandboxed Node.js host process. Webviews are isolated HTML iframes that communicate with the extension host via `postMessage`. The VS Code API provides tree views, output channels, notification dialogs, and command palette registration natively.

## Goals / Non-Goals

**Goals:**
- Real-time agent activity view showing every agent turn as it appears in the audit log
- Phase + artifact status tree in the sidebar, updating live
- Human checkpoint prompts surfaced as VS Code notification dialogs
- Audit log output channel with human-readable, filtered streaming
- Session start / resume / stop via command palette
- Zero changes to coordinator source for v1 — extension is read-only except for `resolve_checkpoint` calls and only shows audit-backed data

**Non-Goals:**
- Replacing the CLI entirely — the coordinator still runs as a separate process
- Editing artifact content from within the extension
- Editing artifact content from within the extension (read-only view only)
- Support for remote (non-loopback) coordinators in v1
- A full MCP client implementation — only the specific HTTP endpoints needed are called directly

## Decisions

### Decision 1: Audit log tail as the primary data source

**Chosen:** The extension tails `sessions/<id>/audit.log` using Node.js `fs.watch` + incremental reads rather than polling the MCP server.

**Rationale:** The audit log is append-only NDJSON and contains every event needed for a full-fidelity UI — agent turns with full message content, phase transitions, checkpoint prompts, and tool calls. The coordinator logs the complete `AgentMessage.content` field on every `agent_invocation` entry, so the extension can render the full conversation without any additional API surface. Tailing a local file gives sub-second latency. The MCP server is only called for write operations (`resolve_checkpoint`).

**Alternative considered:** Polling `get_session_state` via MCP every N seconds — rejected because it misses individual agent turns (only exposes aggregate state) and adds polling latency.

### Decision 2: Webview for conversation view, Tree view for phase/artifact status

**Chosen:** Conversation panel uses a VS Code Webview (full HTML/CSS rendering). Phase status uses a native `TreeDataProvider` sidebar view.

**Rationale:** The agent activity stream includes structured badges and summary metadata (role, action, artifact, round, phase) that benefit from rich HTML rendering even without full message bodies. The sidebar status tree maps naturally to VS Code's native tree view API, which integrates with the activity bar and supports icons without a custom webview.

**Alternative considered:** A single webview for everything — rejected because native tree views are themeable, keyboard-navigable, and integrate with VS Code's sidebar without custom CSS.

### Decision 3: `resolve_checkpoint` via direct MCP HTTP POST

**Chosen:** When the user clicks Proceed/Abort in a checkpoint notification, the extension sends a `POST /message` to the coordinator's MCP HTTP transport with the `resolve_checkpoint` tool call payload.

**Rationale:** The coordinator already validates and processes this tool call. Re-using the existing MCP transport means no new coordinator API surface.

**Alternative considered:** Writing a sentinel file that the coordinator watches — rejected as a fragile side-channel that would require coordinator changes.

### Decision 4: `mcp-config.json` as shared configuration

**Chosen:** The extension reads `mcp-config.json` from the workspace root to discover the coordinator's port, host, and root directory. For v1 it assumes session storage is the default `sessions/` directory under the workspace root. No extension-specific settings file.

**Rationale:** This matches the current config schema without coordinator changes. Host and port remain a single source of truth, while session discovery stays compatible with the repo's documented default layout. Support for arbitrary session directories would require an additional config field or coordinator API.

### Decision 5: Extension co-located in `vscode-extension/` subdirectory

**Chosen:** New `vscode-extension/` package in the same repository, with its own `package.json` and `tsconfig.json`, separate from the coordinator's build.

**Rationale:** Keeps the coordinator's `npm install` clean (no VS Code devDependencies bleeding in). Extension can be packaged as a `.vsix` independently. Shared types (e.g. `AgentMessage`) can be imported via a relative path.

### Decision 6: Typed internal event bus decouples producers from consumers

**Chosen:** A single `ExtensionEventBus` class owns one `vscode.EventEmitter<T>` per event type. Producers (`AuditLogTailer`, `SessionWatcher`, `McpClient`) publish typed events to the bus. Consumers (`ConversationPanel`, `SessionTreeDataProvider`, `CheckpointDetector`, `AuditLogChannel`, status bar) subscribe only to the event types they care about. Nothing is directly wired together.

```
AuditLogTailer  ──publish(AgentTurnEvent)──────────▶  ExtensionEventBus
SessionWatcher  ──publish(SessionChangedEvent)──────▶       │
McpClient       ──publish(ConnectionStateEvent)─────▶       │
                                                            │ subscribe
                                                   ┌────────┴────────────┐
                                            ConversationPanel  SessionTreeDataProvider
                                            CheckpointDetector AuditLogChannel
                                            StatusBarItem
```

Event types:
- `agent_turn` — a new agent-turn summary arrived from the audit log
- `phase_changed` — the workflow moved to a new phase, derived from `phase_advance` and `phase_complete`
- `checkpoint_triggered` — coordinator is blocked awaiting a human decision
- `checkpoint_resolved` — a checkpoint was resolved (proceed/abort)
- `tool_call` — an MCP tool was invoked
- `session_changed` — the active session ID changed
- `connection_state` — coordinator reachable/unreachable/reconnecting

Audit-to-extension event mapping:
- `agent_invocation` → `agent_turn`
- `phase_advance` and `phase_complete` → `phase_changed`
- `checkpoint_presented` → `checkpoint_triggered`
- `checkpoint_resolved` → `checkpoint_resolved`
- `tool_call` → `tool_call`
- session directory switch or user selection → `session_changed`

**Rationale:** The original design used `ConnectionManager.onEvent` as a single multiplexed emitter, which means `ConnectionManager` had to know about all event types and every consumer was coupled to it. With a typed bus, adding a new view or a new event type touches only the producer and consumer — nothing in between changes. Each `subscribe()` call returns a `vscode.Disposable` that integrates naturally with VS Code's `context.subscriptions` for leak-free teardown.

**Alternative considered:** `ConnectionManager` with a single untyped `onEvent` emitter — rejected because it couples all consumers to `ConnectionManager` and requires consumers to filter by event type at runtime rather than at the subscription site.

## Risks / Trade-offs

- **Audit log rotation or truncation** → Mitigation: the coordinator's `AuditLogger` is append-only by design; extension tracks byte offset and re-reads from last known position on each `fs.watch` event.
- **Coordinator not running when extension activates** → Mitigation: extension enters a "waiting" state and polls for `mcp-config.json` + an active session directory; shows a status bar item indicating disconnected state.
- **MCP session ID required for `resolve_checkpoint` POST** → Mitigation: extension establishes a persistent SSE connection to `/sse` at startup to obtain a session ID, kept alive for the duration of the workflow.
- **Custom sessions directory is unsupported in shared config** → Mitigation: v1 assumes the documented default `sessions/` directory under the workspace root and surfaces a warning if it cannot be found.
- **Webview content security policy** → Mitigation: all HTML is generated in the extension host and passed via `postMessage`; no external script sources; nonce-based CSP applied to every webview panel.
- **Multiple sessions in `sessions/`** → Mitigation: extension tracks the most-recently-modified session directory by watching the `sessions/` folder; allows user to switch session via command palette.

## Migration Plan

This is a net-new package; no migration is needed for the coordinator. Installation steps:

1. `cd vscode-extension && npm install`
2. Open the repo in VS Code and press F5 to launch the Extension Development Host, or install the packaged `.vsix` via the Extensions panel.
3. Start the coordinator in a terminal (`npm start -- start --workflow proposal`).
4. The extension detects the running session automatically.

Rollback: uninstall the extension; coordinator is unaffected.

## Open Questions

- Should the conversation webview support copying individual agent-turn summaries to the clipboard?
- Should checkpoint notifications be modal (blocking) or non-modal? Non-modal is less disruptive but easier to miss.
- Should the extension also stream coordinator `console.log` output (stdout) or only the structured audit log?
