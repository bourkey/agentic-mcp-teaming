import * as vscode from "vscode";
import type { ExtensionEventBus } from "../bus/ExtensionEventBus";
import type { EventTypeMap } from "../events";
import { FilterManager } from "./FilterManager";

type AnyEvent = EventTypeMap[keyof EventTypeMap];

function format(event: AnyEvent): string {
  const ts = "timestamp" in event ? (event as { timestamp: string }).timestamp : new Date().toISOString();
  const prefix = `[${ts}]`;

  switch (event.type) {
    case "agent_turn":
      return `${prefix} [agent_turn] ${event.agentId} → ${event.artifactId} r${event.round} (${event.action}): ${event.content.slice(0, 200)}${event.content.length > 200 ? "…" : ""}`;
    case "tool_call":
      return `${prefix} [tool_call] ${event.tool} params=${JSON.stringify(event.params)}`;
    case "phase_changed":
      return `${prefix} [phase_changed] ${event.fromPhase} → ${event.toPhase}`;
    case "artifact_outcome":
      return `${prefix} [artifact_outcome] artifact=${event.artifactId} outcome=${event.outcome} rounds=${event.rounds}`;
    case "checkpoint_triggered":
      return `${prefix} [checkpoint_presented] artifact=${event.artifactId} reason=${event.reason}`;
    case "checkpoint_resolved":
      return `${prefix} [checkpoint_resolved] artifact=${event.artifactId} decision=${event.decision} outcome=${event.outcome}`;
    case "session_changed":
      return `${prefix} [session_changed] sessionId=${event.sessionId ?? "(cleared)"}`;
    case "connection_state":
      return `${prefix} [connection_state] ${event.state}`;
    default:
      return `${prefix} ${JSON.stringify(event)}`;
  }
}

export class AuditLogChannel {
  private readonly channel: vscode.OutputChannel;
  readonly filter: FilterManager;

  constructor(bus: ExtensionEventBus, context: vscode.ExtensionContext) {
    this.channel = vscode.window.createOutputChannel("MCP Coordinator");
    this.filter = new FilterManager();
    context.subscriptions.push(this.channel);

    const append = (event: AnyEvent) => {
      if (this.filter.isAllowed(event.type as keyof EventTypeMap)) {
        this.channel.appendLine(format(event));
      }
    };

    bus.subscribe("agent_turn", append, context);
    bus.subscribe("tool_call", append, context);
    bus.subscribe("phase_changed", append, context);
    bus.subscribe("artifact_outcome", append, context);
    bus.subscribe("checkpoint_triggered", append, context);
    bus.subscribe("checkpoint_resolved", append, context);
    bus.subscribe("session_changed", append, context);
    bus.subscribe("connection_state", append, context);
  }
}
