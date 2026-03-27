import * as vscode from "vscode";
import type { ExtensionEventBus } from "../bus/ExtensionEventBus";
import { ConfigLoader } from "./ConfigLoader";
import { SessionWatcher } from "./SessionWatcher";
import { AuditLogTailer } from "./AuditLogTailer";
import { McpClient } from "./McpClient";

export class ConnectionManager {
  readonly config: ConfigLoader;
  readonly sessionWatcher: SessionWatcher;
  readonly auditLogTailer: AuditLogTailer;
  mcpClient: McpClient | null = null;

  constructor(
    workspaceRoot: string,
    private readonly bus: ExtensionEventBus,
  ) {
    this.config = new ConfigLoader(workspaceRoot);
    const sessionsPath = this.config.sessionsPath();
    this.sessionWatcher = new SessionWatcher(sessionsPath, bus);
    this.auditLogTailer = new AuditLogTailer(sessionsPath, bus);
  }

  init(context: vscode.ExtensionContext): void {
    const cfg = this.config.load();
    if (!cfg) {
      this.bus.publish({ type: "connection_state", state: "disconnected" });
      return;
    }

    this.mcpClient = new McpClient(cfg.host, cfg.port, this.bus, cfg.authToken);
    context.subscriptions.push({ dispose: () => this.mcpClient?.dispose() });

    this.sessionWatcher.start(context);

    this.bus.subscribe("session_changed", (event) => {
      if (event.sessionId) {
        this.auditLogTailer.tail(event.sessionId);
      } else {
        this.auditLogTailer.stop();
      }
    }, context);

    this.mcpClient.connect();
  }
}
