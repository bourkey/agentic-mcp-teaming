import * as vscode from "vscode";
import type { ExtensionEventBus } from "../bus/ExtensionEventBus";
import type { McpClient } from "../connection/McpClient";

export class CheckpointHandler {
  private readonly resolved = new Set<string>();

  constructor(
    bus: ExtensionEventBus,
    private readonly mcpClient: McpClient,
    context: vscode.ExtensionContext,
  ) {
    bus.subscribe("checkpoint_triggered", (event) => {
      if (this.resolved.has(event.artifactId)) return;
      void this.handleCheckpoint(event.artifactId, bus);
    }, context);

    bus.subscribe("checkpoint_resolved", (event) => {
      this.resolved.add(event.artifactId);
    }, context);
  }

  private async handleCheckpoint(
    artifactId: string,
    bus: ExtensionEventBus,
  ): Promise<void> {
    const choice = await vscode.window.showInformationMessage(
      `Checkpoint reached for artifact: ${artifactId}. How do you want to proceed?`,
      "Proceed",
      "Abort",
    );
    if (!choice) return;

    const decision = choice === "Proceed" ? "proceed" : "abort";

    const attempt = async (): Promise<boolean> => {
      try {
        await this.mcpClient.callTool("resolve_checkpoint", { decision, artifactId });
        this.resolved.add(artifactId);
        bus.publish({
          type: "checkpoint_resolved",
          decision: decision === "abort" ? "abort" : "proceed",
          artifactId,
          outcome: decision === "abort" ? "aborted" : "human-approved",
          timestamp: new Date().toISOString(),
        });
        return true;
      } catch {
        return false;
      }
    };

    if (await attempt()) return;

    const retry = await vscode.window.showErrorMessage(
      `Failed to resolve checkpoint for "${artifactId}". Retry?`,
      "Retry",
    );
    if (retry === "Retry") {
      if (!(await attempt())) {
        void vscode.window.showErrorMessage(
          `Checkpoint resolution for "${artifactId}" failed. Please resolve manually.`,
        );
      }
    }
  }
}
