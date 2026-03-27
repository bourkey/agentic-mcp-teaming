## Why

The agentic MCP teaming coordinator runs entirely in a terminal, leaving users with no visibility into what the agents are discussing, where the workflow stands, or how to interact with human checkpoints without switching context to a shell. A VS Code extension surfaces the coordinator's live session data inside the IDE, so the user can watch the Claude–Codex conversation unfold, track phase and consensus progress, and respond to checkpoints without leaving the editor.

## What Changes

- New VS Code extension package (`vscode-extension/`) added to the repository alongside the existing coordinator
- Extension connects to a running coordinator MCP server and tails the session audit log to reconstruct live state
- Dedicated webview panel renders the full agent conversation — every message body, round-by-round consensus outcomes, and review feedback in context
- Phase progress shown in a VS Code tree view (sidebar) with per-phase and per-artifact status
- Human checkpoint prompts replaced by native VS Code notification dialogs with Proceed / Abort buttons
- Session management commands added to the VS Code command palette (start, resume, stop coordinator)
- Audit log streamed into a dedicated VS Code Output Channel

## Capabilities

### New Capabilities

- `coordinator-connection`: Connect to a running coordinator process — read `mcp-config.json` to discover the MCP server URL, poll or stream the session audit log, and expose live session state to all extension views
- `session-panel`: Sidebar tree view showing workflow phase sequence, current phase, per-artifact consensus status, and session metadata; exposes Start / Resume / Stop commands via the command palette
- `conversation-view`: Webview panel rendering the full live agent conversation — each turn as a styled message bubble with role, action badge (approve / request-changes / block), artifact ID, round number, and full message content rendered as markdown; auto-scrolls as new turns arrive
- `checkpoint-ui`: Intercept `checkpoint_presented` events from the audit log stream and surface them as VS Code information messages with native Proceed and Abort buttons; writes the decision back to the coordinator via its `resolve_checkpoint` MCP tool
- `audit-log-view`: Dedicated VS Code Output Channel that streams every NDJSON audit log entry in real time, formatted for readability, with filtering by entry type

### Modified Capabilities

## Impact

- New `vscode-extension/` directory with its own `package.json`, TypeScript source, and VS Code extension manifest (`package.json` `contributes` section)
- One-line coordinator change: `agent_invocation` audit log entries now include the full `content` field (agent message body) instead of `contentLength` only — required to surface full conversation in the extension
- New dev dependency: `@types/vscode`; runtime dependencies: none beyond VS Code's built-in APIs
- `mcp-config.json` used by both coordinator and extension as the shared config source for host/port/rootDir; the extension assumes the default `sessions/` directory under the workspace root for v1
