import * as vscode from "vscode";
import type { ExtensionEventBus } from "../bus/ExtensionEventBus";
import type { AgentTurnEvent } from "../events";

function getNonce(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let result = "";
  for (let i = 0; i < 32; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

function getWebviewContent(nonce: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Coordinator Conversation</title>
  <style nonce="${nonce}">
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      color: var(--vscode-editor-foreground);
      background: var(--vscode-editor-background);
      padding: 8px;
      overflow-y: auto;
    }
    .round-header {
      display: flex;
      align-items: center;
      gap: 8px;
      margin: 16px 0 8px;
      font-size: 0.85em;
      color: var(--vscode-descriptionForeground);
    }
    .round-header::before,
    .round-header::after {
      content: '';
      flex: 1;
      border-top: 1px solid var(--vscode-widget-border);
    }
    .bubble {
      margin-bottom: 8px;
      padding: 8px 12px;
      border-radius: 6px;
      border: 1px solid var(--vscode-widget-border);
      background: var(--vscode-editorWidget-background);
    }
    .bubble-header {
      display: flex;
      align-items: center;
      gap: 8px;
      margin-bottom: 6px;
      font-size: 0.8em;
    }
    .role {
      font-weight: 600;
      color: var(--vscode-editor-foreground);
    }
    .artifact {
      color: var(--vscode-descriptionForeground);
    }
    .badge {
      padding: 1px 6px;
      border-radius: 3px;
      font-size: 0.75em;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.05em;
    }
    .badge-approve    { background: #1a7f3c; color: #fff; }
    .badge-changes    { background: #b45309; color: #fff; }
    .badge-block      { background: #b91c1c; color: #fff; }
    .badge-comment    { background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); }
    .badge-in-progress { background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); }
    .content {
      white-space: pre-wrap;
      word-break: break-word;
      line-height: 1.5;
    }
  </style>
</head>
<body>
  <div id="messages"></div>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const container = document.getElementById('messages');

    // track rounds: key = "artifactId:round" => {header, agents seen}
    const roundHeaders = new Map();
    let userScrolledUp = false;

    window.addEventListener('scroll', () => {
      const atBottom = window.innerHeight + window.scrollY >= document.body.scrollHeight - 20;
      userScrolledUp = !atBottom;
    });

    function scrollToBottom() {
      if (!userScrolledUp) {
        window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' });
      }
    }

    function badgeClass(action) {
      switch (action) {
        case 'approve': return 'badge-approve';
        case 'request-changes': return 'badge-changes';
        case 'block': return 'badge-block';
        default: return 'badge-comment';
      }
    }

    function escapeHtml(str) {
      return str
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
    }

    function ensureRoundHeader(artifactId, round) {
      const key = artifactId + ':' + round;
      if (!roundHeaders.has(key)) {
        const header = document.createElement('div');
        header.className = 'round-header';
        header.textContent = artifactId + ' — Round ' + round;
        container.appendChild(header);
        roundHeaders.set(key, header);
      }
    }

    window.addEventListener('message', (event) => {
      const msg = event.data;
      if (msg.type !== 'agent_turn') return;

      ensureRoundHeader(msg.artifactId, msg.round);

      const bubble = document.createElement('div');
      bubble.className = 'bubble';
      bubble.innerHTML =
        '<div class="bubble-header">' +
          '<span class="role">' + escapeHtml(msg.agentId) + '</span>' +
          '<span class="artifact">' + escapeHtml(msg.artifactId) + '</span>' +
          '<span class="badge ' + badgeClass(msg.action) + '">' + escapeHtml(msg.action) + '</span>' +
        '</div>' +
        '<div class="content">' + escapeHtml(msg.content) + '</div>';
      container.appendChild(bubble);
      scrollToBottom();
    });
  </script>
</body>
</html>`;
}

export class ConversationPanel {
  private panel: vscode.WebviewPanel | null = null;
  private readonly extensionUri: vscode.Uri;

  constructor(bus: ExtensionEventBus, context: vscode.ExtensionContext) {
    this.extensionUri = context.extensionUri;

    bus.subscribe("agent_turn", (event: AgentTurnEvent) => {
      if (this.panel) {
        void this.panel.webview.postMessage(event);
      }
    }, context);
  }

  open(): void {
    if (this.panel) {
      this.panel.reveal();
      return;
    }

    const nonce = getNonce();
    this.panel = vscode.window.createWebviewPanel(
      "coordinatorConversation",
      "Coordinator Conversation",
      vscode.ViewColumn.Beside,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [this.extensionUri],
      },
    );

    this.panel.webview.html = getWebviewContent(nonce);

    this.panel.onDidDispose(() => {
      this.panel = null;
    });
  }
}
