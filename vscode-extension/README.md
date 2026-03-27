# Coordinator VS Code Extension

A VS Code extension that gives you real-time visibility into a running multi-agent coordinator session.

## Prerequisites

- The coordinator server must be running (see the root [`readme.md`](../readme.md) for setup).
- A `mcp-config.json` must exist at the workspace root specifying the coordinator host and port.

```json
{
  "host": "localhost",
  "port": 3000
}
```

## Installation

1. Open the `vscode-extension/` directory in VS Code.
2. Run `npm install` then `npm run build` to bundle the extension.
3. Press **F5** to launch an Extension Development Host, or package with `vsce package`.

## Commands

| Command | Description |
|---|---|
| `Coordinator: Start` | Launch the coordinator in a terminal (`npm start -- start --workflow proposal`) |
| `Coordinator: Resume Session` | Pick a past session ID and resume it |
| `Coordinator: Stop` | Dispose the coordinator terminal |
| `Coordinator: Switch Session` | Switch the extension's active session view |
| `Coordinator: Open Conversation` | Open the Conversation webview panel |
| `Coordinator: Filter Audit Log` | Multi-select which entry types appear in the MCP Coordinator output channel |

## Views

- **Coordinator Session** (Activity Bar sidebar): Shows the six workflow phases (proposal → review), with artifact children showing consensus outcome, round, and awaiting-decision status.
- **Coordinator Conversation** (Webview Panel): Streams agent messages as styled bubbles with action badges (green = approve, amber = request-changes, red = block).
- **MCP Coordinator** (Output Channel): Formatted audit log stream, filterable by entry type.

## Screenshot

_TODO: add screenshot_

## Troubleshooting

- **"No active session"** in the sidebar: ensure the coordinator has started at least one session. Check the `sessions/` directory.
- **Status bar shows "Coordinator: idle"**: the extension cannot reach the coordinator. Verify `mcp-config.json` host/port and that the coordinator server is running.
- **Checkpoint notification not appearing**: ensure the MCP server is reachable (`McpClient` SSE connection must be established).
