## 0. Coordinator Prerequisite

- [x] 0.1 In `src/server/tools/agents.ts`, update both `invokeClaudeTool` and `invokeCodexTool` audit log calls to log `content: msg.content` instead of `contentLength: msg.content.length` so the full agent message body is available to the extension

## 1. Extension Bootstrap

- [x] 1.1 Create `vscode-extension/` directory with `package.json` (extension manifest), `tsconfig.json`, and `.vscodeignore`
- [x] 1.2 Add VS Code extension dependencies: `@types/vscode`, `esbuild` (bundler); configure `engines.vscode` minimum version
- [x] 1.3 Register extension activation event, contributes (commands, views, activitybar) in `package.json`
- [x] 1.4 Implement `extension.ts` entry point: `activate()` wires up all providers and disposes them on deactivate

## 2. Event Bus and Coordinator Connection

- [x] 2.1 Implement `ExtensionEventBus`: one `vscode.EventEmitter<T>` per event type; typed `publish(event)` and `subscribe(type, handler) → Disposable` methods; all subscriptions register into `context.subscriptions` for automatic teardown
- [x] 2.2 Define all event payload types in `events.ts`: `AgentTurnEvent`, `PhaseChangedEvent`, `CheckpointTriggeredEvent`, `CheckpointResolvedEvent`, `ToolCallEvent`, `SessionChangedEvent`, `ConnectionStateEvent`
- [x] 2.3 Implement `ConfigLoader`: reads `mcp-config.json` from workspace root, returns `{ host, port, rootDir }` or null if absent; resolve sessions path as `<workspaceRoot>/sessions` for v1
- [x] 2.4 Implement `SessionWatcher`: uses `fs.watch` on the sessions directory; publishes `SessionChangedEvent` to the bus when the active session changes
- [x] 2.5 Implement `AuditLogTailer`: watches `sessions/<id>/audit.log` for appended NDJSON lines; parses each entry, translates audit entry types (`agent_invocation`, `phase_advance`, `phase_complete`, `checkpoint_presented`, `checkpoint_resolved`, `tool_call`) into extension bus events, and tracks byte offset across watch cycles
- [x] 2.6 Implement `McpClient`: holds a persistent SSE connection to `/sse`; publishes `ConnectionStateEvent` on connect/disconnect/retry; exposes `callTool(name, params)` → `POST /message` with exponential backoff retry
- [x] 2.7 Implement `ConnectionManager`: composes `ConfigLoader`, `SessionWatcher`, `AuditLogTailer`, and `McpClient`; passes the shared `ExtensionEventBus` to each producer on init; owns no consumer logic
- [x] 2.8 Implement status bar item: subscribes to `ConnectionStateEvent` and `PhaseChangedEvent` from the bus; displays "Coordinator: idle", "Coordinator: connecting…", or "Coordinator: <phase> (round <n>)"
- [x] 2.9 Write unit tests for `AuditLogTailer`: byte-offset tracking, correct event type published per entry type, malformed line tolerance, file-not-yet-created handling
- [x] 2.10 Write unit tests for `ExtensionEventBus`: typed dispatch, multiple subscribers per event type, disposable cleanup

## 3. Session Panel (Sidebar Tree View)

- [x] 3.1 Implement `SessionTreeDataProvider` implementing `vscode.TreeDataProvider`; nodes: phase list → artifact children with consensus outcome and round count
- [x] 3.2 Subscribe `SessionTreeDataProvider` to `PhaseChangedEvent`, `CheckpointTriggeredEvent`, `CheckpointResolvedEvent`, and `SessionChangedEvent` on the bus; call `_onDidChangeTreeData.fire()` on each
- [x] 3.3 Register "Coordinator: Start" command: launch coordinator via `vscode.window.createTerminal` + `terminal.sendText("npm start -- start --workflow proposal")`
- [x] 3.4 Register "Coordinator: Resume Session" command: quick-pick over session IDs, spawn coordinator with `--session <id>`
- [x] 3.5 Register "Coordinator: Stop" command: dispose the terminal instance created by Start/Resume
- [x] 3.6 Register "Coordinator: Switch Session" command: quick-pick over session IDs, publish `SessionChangedEvent` to the bus
- [x] 3.7 Write unit tests for `SessionTreeDataProvider`: correct node structure for various session states

## 4. Conversation View (Webview Panel)

- [x] 4.1 Implement `ConversationPanel`: creates and manages a `vscode.WebviewPanel` with nonce-based CSP; exposes `postMessage` bridge
- [x] 4.2 Write webview HTML/CSS: message bubble layout with role label, action badge (colour-coded: green/approve, amber/request-changes, red/block), artifact ID, round, and full markdown content body
- [x] 4.3 Implement round-group headers in the webview: inserted at each new artifact+round boundary, updated in-place when both agents' turns arrive
- [x] 4.4 Implement auto-scroll logic in webview JS: scroll to bottom on new message unless user has scrolled up; re-enable on return to bottom
- [x] 4.5 Subscribe `ConversationPanel` to `AgentTurnEvent` on the bus; forward each event to the webview via `postMessage`
- [x] 4.6 Register "Coordinator: Open Conversation" command and sidebar button to open/reveal the panel
- [x] 4.7 Write integration tests for `ConversationPanel`: full content rendered as markdown for each action type, round header updates

## 5. Checkpoint UI

- [x] 5.1 Implement `CheckpointHandler`: subscribes to `CheckpointTriggeredEvent` and `CheckpointResolvedEvent` on the bus; treats `checkpoint_presented` as the trigger source and tracks which checkpoints have already been resolved to avoid re-showing them on replay
- [x] 5.2 On unresolved `CheckpointTriggeredEvent`, call `vscode.window.showInformationMessage` with "Proceed" and "Abort" buttons; on click, call `McpClient.callTool("resolve_checkpoint", { decision, artifactId })` then publish `CheckpointResolvedEvent` to the bus
- [x] 5.3 Show error notification with retry option when the `resolve_checkpoint` MCP call fails
- [x] 5.4 Write unit tests for `CheckpointHandler`: skip already-resolved checkpoints, correct bus event published on decision

## 6. Audit Log Output Channel

- [x] 6.1 Implement `AuditLogChannel`: creates the "MCP Coordinator" `vscode.OutputChannel` on activation; subscribes to all event types on the bus
- [x] 6.2 Implement per-entry-type formatters: `agent_invocation`, `tool_call`, `phase_complete`/`phase_advance`, `checkpoint_presented`/`checkpoint_resolved`, `session_start`/`session_complete`, unknown (raw JSON fallback)
- [x] 6.3 Implement `FilterManager`: stores a set of allowed entry types; default is all types; `AuditLogChannel` checks filter before appending
- [x] 6.4 Register "Coordinator: Filter Audit Log" command: multi-select quick-pick of entry types; "Show All" option clears filter
- [x] 6.5 Write unit tests for entry-type formatters: correct output string for each known entry type

## 7. Packaging and Documentation

- [x] 7.1 Configure `esbuild` build script in `vscode-extension/package.json` to bundle extension host code into `dist/extension.js`
- [x] 7.2 Add `vscode:prepublish` script and `.vscodeignore` to exclude source/test files from the packaged `.vsix`
- [x] 7.3 Write `vscode-extension/README.md`: prerequisites (coordinator running), installation, commands reference, screenshot placeholder
- [x] 7.4 Add launch configuration to root `.vscode/launch.json` (or create it) for "Extension Development Host" pointing at `vscode-extension/`
