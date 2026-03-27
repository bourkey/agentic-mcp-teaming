export type ConnectionState = "idle" | "connecting" | "connected" | "reconnecting" | "disconnected";

export interface AgentTurnEvent {
  type: "agent_turn";
  sessionId: string;
  agentId: string;
  phase: string;
  action: string;
  artifactId: string;
  round: number;
  content: string;
  timestamp: string;
}

export interface PhaseChangedEvent {
  type: "phase_changed";
  fromPhase: string;
  toPhase: string;
  timestamp: string;
}

export interface ArtifactOutcomeEvent {
  type: "artifact_outcome";
  artifactId: string;
  outcome: string;
  rounds: number;
  timestamp: string;
}

export interface CheckpointTriggeredEvent {
  type: "checkpoint_triggered";
  artifactId: string;
  reason: string;
  sessionId: string;
  timestamp: string;
}

export interface CheckpointResolvedEvent {
  type: "checkpoint_resolved";
  decision: "proceed" | "abort";
  artifactId: string;
  outcome: string;
  timestamp: string;
}

export interface ToolCallEvent {
  type: "tool_call";
  tool: string;
  params: Record<string, unknown>;
  sessionId: string;
  timestamp: string;
}

export interface SessionChangedEvent {
  type: "session_changed";
  sessionId: string | null;
}

export interface ConnectionStateEvent {
  type: "connection_state";
  state: ConnectionState;
}

export type EventTypeMap = {
  agent_turn: AgentTurnEvent;
  phase_changed: PhaseChangedEvent;
  artifact_outcome: ArtifactOutcomeEvent;
  checkpoint_triggered: CheckpointTriggeredEvent;
  checkpoint_resolved: CheckpointResolvedEvent;
  tool_call: ToolCallEvent;
  session_changed: SessionChangedEvent;
  connection_state: ConnectionStateEvent;
};

export type EventType = keyof EventTypeMap;
