import { describe, it, expect, vi, beforeEach } from "vitest";
import { AuditLogTailer } from "../src/connection/AuditLogTailer";
import type { ExtensionEventBus } from "../src/bus/ExtensionEventBus";

// Minimal bus stub
function makeBus() {
  const published: unknown[] = [];
  return {
    published,
    publish: (event: unknown) => { published.push(event); },
    subscribe: () => ({ dispose: () => {} }),
  } as unknown as ExtensionEventBus & { published: unknown[] };
}

describe("AuditLogTailer.processLine (via tail stub)", () => {
  let bus: ReturnType<typeof makeBus>;
  let tailer: AuditLogTailer;
  const warnings: string[] = [];

  beforeEach(() => {
    bus = makeBus();
    tailer = new AuditLogTailer("/fake/sessions", bus as unknown as ExtensionEventBus, (msg) => warnings.push(msg));
  });

  it("publishes agent_turn for agent_invocation entries", () => {
    // Access private method via cast for unit testing
    const t = tailer as unknown as { processLine(line: string): void };
    t.processLine(JSON.stringify({
      type: "agent_invocation",
      sessionId: "s1",
      agentId: "architect",
      phase: "design",
      artifactId: "design-doc",
      round: 2,
      timestamp: "2024-01-01T00:00:00Z",
      response: { action: "approve", content: "looks good" },
    }));
    expect(bus.published).toHaveLength(1);
    const event = bus.published[0] as Record<string, unknown>;
    expect(event["type"]).toBe("agent_turn");
    expect(event["agentId"]).toBe("architect");
    expect(event["action"]).toBe("approve");
    expect(event["content"]).toBe("looks good");
    expect(event["round"]).toBe(2);
  });

  it("publishes phase_changed for phase_advance entries", () => {
    const t = tailer as unknown as { processLine(line: string): void };
    t.processLine(JSON.stringify({
      type: "phase_advance",
      fromPhase: "proposal",
      toPhase: "design",
      timestamp: "2024-01-01T00:00:00Z",
    }));
    const event = bus.published[0] as Record<string, unknown>;
    expect(event["type"]).toBe("phase_changed");
    expect(event["fromPhase"]).toBe("proposal");
    expect(event["toPhase"]).toBe("design");
  });

  it("publishes phase_changed for phase_complete entries using phase field", () => {
    const t = tailer as unknown as { processLine(line: string): void };
    t.processLine(JSON.stringify({
      type: "phase_complete",
      fromPhase: "design",
      phase: "design",
      timestamp: "2024-01-01T00:00:00Z",
    }));
    const event = bus.published[0] as Record<string, unknown>;
    expect(event["type"]).toBe("phase_changed");
    expect(event["toPhase"]).toBe("design");
  });

  it("publishes artifact_outcome for consensus_end entries", () => {
    const t = tailer as unknown as { processLine(line: string): void };
    t.processLine(JSON.stringify({
      type: "consensus_end",
      artifactId: "design-doc",
      outcome: "consensus-reached",
      rounds: 2,
      timestamp: "2024-01-01T00:00:00Z",
    }));
    const event = bus.published[0] as Record<string, unknown>;
    expect(event["type"]).toBe("artifact_outcome");
    expect(event["artifactId"]).toBe("design-doc");
    expect(event["outcome"]).toBe("consensus-reached");
    expect(event["rounds"]).toBe(2);
  });

  it("publishes checkpoint_triggered for checkpoint_presented entries", () => {
    const t = tailer as unknown as { processLine(line: string): void };
    t.processLine(JSON.stringify({
      type: "checkpoint_presented",
      artifactId: "spec-doc",
      reason: "needs human review",
      sessionId: "s1",
      timestamp: "2024-01-01T00:00:00Z",
    }));
    const event = bus.published[0] as Record<string, unknown>;
    expect(event["type"]).toBe("checkpoint_triggered");
    expect(event["artifactId"]).toBe("spec-doc");
    expect(event["reason"]).toBe("needs human review");
  });

  it("publishes checkpoint_resolved for checkpoint_resolved entries", () => {
    const t = tailer as unknown as { processLine(line: string): void };
    t.processLine(JSON.stringify({
      type: "checkpoint_resolved",
      artifactId: "spec-doc",
      decision: "proceed",
      outcome: "human-approved",
      timestamp: "2024-01-01T00:00:00Z",
    }));
    const event = bus.published[0] as Record<string, unknown>;
    expect(event["type"]).toBe("checkpoint_resolved");
    expect(event["decision"]).toBe("proceed");
    expect(event["outcome"]).toBe("human-approved");
  });

  it("maps abort decision correctly", () => {
    const t = tailer as unknown as { processLine(line: string): void };
    t.processLine(JSON.stringify({
      type: "checkpoint_resolved",
      artifactId: "spec-doc",
      decision: "abort",
      outcome: "aborted",
      timestamp: "2024-01-01T00:00:00Z",
    }));
    const event = bus.published[0] as Record<string, unknown>;
    expect(event["decision"]).toBe("abort");
  });

  it("publishes tool_call for tool_call entries", () => {
    const t = tailer as unknown as { processLine(line: string): void };
    t.processLine(JSON.stringify({
      type: "tool_call",
      tool: "read_file",
      params: { path: "/foo" },
      sessionId: "s1",
      timestamp: "2024-01-01T00:00:00Z",
    }));
    const event = bus.published[0] as Record<string, unknown>;
    expect(event["type"]).toBe("tool_call");
    expect(event["tool"]).toBe("read_file");
  });

  it("ignores unknown entry types", () => {
    const t = tailer as unknown as { processLine(line: string): void };
    t.processLine(JSON.stringify({ type: "unknown_type", foo: "bar" }));
    expect(bus.published).toHaveLength(0);
  });

  it("logs warning and skips malformed NDJSON", () => {
    const t = tailer as unknown as { processLine(line: string): void };
    t.processLine("not valid json {{{");
    expect(bus.published).toHaveLength(0);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("malformed");
  });
});
