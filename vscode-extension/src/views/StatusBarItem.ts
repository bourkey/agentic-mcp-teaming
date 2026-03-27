import * as vscode from "vscode";
import type { ExtensionEventBus } from "../bus/ExtensionEventBus";

export function createStatusBarItem(
  bus: ExtensionEventBus,
  context: vscode.ExtensionContext,
): vscode.StatusBarItem {
  const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  item.command = "coordinator.openConversation";
  item.text = "Coordinator: idle";
  item.show();
  context.subscriptions.push(item);

  bus.subscribe("connection_state", (event) => {
    switch (event.state) {
      case "idle":
      case "disconnected":
        item.text = "Coordinator: idle";
        break;
      case "connecting":
        item.text = "Coordinator: connecting…";
        break;
      case "reconnecting":
        item.text = "Coordinator: reconnecting…";
        break;
      case "connected":
        item.text = "Coordinator: connected";
        break;
    }
  }, context);

  bus.subscribe("phase_changed", (event) => {
    item.text = `Coordinator: ${event.toPhase} (round 0)`;
  }, context);

  return item;
}
