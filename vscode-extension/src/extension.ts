import * as vscode from "vscode";
import { ExtensionEventBus } from "./bus/ExtensionEventBus";
import { ConnectionManager } from "./connection/ConnectionManager";
import { createStatusBarItem } from "./views/StatusBarItem";
import { SessionTreeDataProvider } from "./views/SessionTreeDataProvider";
import { ConversationPanel } from "./views/ConversationPanel";
import { CheckpointHandler } from "./handlers/CheckpointHandler";
import { AuditLogChannel } from "./handlers/AuditLogChannel";

let terminal: vscode.Terminal | null = null;

export function activate(context: vscode.ExtensionContext): void {
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? "";

  const bus = new ExtensionEventBus();
  const connection = new ConnectionManager(workspaceRoot, bus);
  connection.init(context);

  createStatusBarItem(bus, context);

  const treeProvider = new SessionTreeDataProvider(bus, context);
  const treeView = vscode.window.createTreeView("coordinatorSession", {
    treeDataProvider: treeProvider,
    showCollapseAll: false,
  });
  context.subscriptions.push(treeView);

  const conversationPanel = new ConversationPanel(bus, context);
  const auditLogChannel = new AuditLogChannel(bus, context);

  if (connection.mcpClient) {
    new CheckpointHandler(bus, connection.mcpClient, context);
  }

  // Commands: Start
  context.subscriptions.push(
    vscode.commands.registerCommand("coordinator.start", () => {
      terminal?.dispose();
      terminal = vscode.window.createTerminal("Coordinator");
      terminal.show();
      terminal.sendText("npm start -- start --workflow proposal");
    }),
  );

  // Commands: Resume
  context.subscriptions.push(
    vscode.commands.registerCommand("coordinator.resume", async () => {
      const sessionIds = connection.sessionWatcher.listSessionIds();
      if (sessionIds.length === 0) {
        void vscode.window.showInformationMessage("No sessions found.");
        return;
      }
      const picked = await vscode.window.showQuickPick(sessionIds, {
        placeHolder: "Select session to resume",
      });
      if (!picked) return;
      terminal?.dispose();
      terminal = vscode.window.createTerminal("Coordinator");
      terminal.show();
      terminal.sendText(`npm start -- start --session ${picked}`);
    }),
  );

  // Commands: Stop
  context.subscriptions.push(
    vscode.commands.registerCommand("coordinator.stop", () => {
      terminal?.dispose();
      terminal = null;
    }),
  );

  // Commands: Switch Session
  context.subscriptions.push(
    vscode.commands.registerCommand("coordinator.switchSession", async () => {
      const sessionIds = connection.sessionWatcher.listSessionIds();
      if (sessionIds.length === 0) {
        void vscode.window.showInformationMessage("No sessions found.");
        return;
      }
      const picked = await vscode.window.showQuickPick(sessionIds, {
        placeHolder: "Select session to view",
      });
      if (!picked) return;
      connection.sessionWatcher.setActiveSession(picked);
    }),
  );

  // Commands: Open Conversation
  context.subscriptions.push(
    vscode.commands.registerCommand("coordinator.openConversation", () => {
      conversationPanel.open();
    }),
  );

  // Commands: Filter Audit Log
  context.subscriptions.push(
    vscode.commands.registerCommand("coordinator.filterAuditLog", async () => {
      const allTypes = auditLogChannel.filter.getAllTypes();
      const activeTypes = new Set(auditLogChannel.filter.getActiveTypes());

      const items: vscode.QuickPickItem[] = [
        { label: "Show All", description: "Clear all filters" },
        ...allTypes.map((t) => ({
          label: t,
          picked: activeTypes.has(t),
        })),
      ];

      const selected = await vscode.window.showQuickPick(items, {
        canPickMany: true,
        placeHolder: "Select entry types to show in the Audit Log channel",
      });
      if (!selected) return;

      if (selected.some((s) => s.label === "Show All")) {
        auditLogChannel.filter.showAll();
      } else {
        auditLogChannel.filter.setFilter(
          selected.map((s) => s.label as Parameters<typeof auditLogChannel.filter.setFilter>[0][number]),
        );
      }
    }),
  );

  context.subscriptions.push({
    dispose(): void {
      terminal?.dispose();
    },
  });
}

export function deactivate(): void {
  terminal?.dispose();
  terminal = null;
}
