import { describe, it, expect } from "vitest";
import { AuditLogChannel } from "../src/handlers/AuditLogChannel";
import { ExtensionEventBus } from "../src/bus/ExtensionEventBus";

function makeContext(): import("vscode").ExtensionContext {
  return { subscriptions: [], extensionUri: { fsPath: "" } } as unknown as import("vscode").ExtensionContext;
}

// Capture lines appended to the output channel
function captureChannel(bus: ExtensionEventBus) {
  const lines: string[] = [];
  const ctx = makeContext();
  const channel = new AuditLogChannel(bus, ctx);

  // Patch the internal channel.appendLine after construction
  const auditCh = channel as unknown as { channel: { appendLine: (l: string) => void } };
  auditCh.channel.appendLine = (l: string) => lines.push(l);

  return { channel, lines, ctx };
}

describe("AuditLogChannel formatters", () => {
  it("formats agent_turn entries", () => {
    const bus = new ExtensionEventBus();
    const { lines } = captureChannel(bus);

    bus.publish({
      type: "agent_turn",
      sessionId: "s1",
      agentId: "architect",
      phase: "design",
      action: "approve",
      artifactId: "design-doc",
      round: 1,
      content: "Looks good to me.",
      timestamp: "2024-01-01T00:00:00.000Z",
    });

    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("[agent_turn]");
    expect(lines[0]).toContain("architect");
    expect(lines[0]).toContain("approve");
    expect(lines[0]).toContain("Looks good");
  });

  it("formats tool_call entries", () => {
    const bus = new ExtensionEventBus();
    const { lines } = captureChannel(bus);

    bus.publish({
      type: "tool_call",
      tool: "read_file",
      params: { path: "/foo.ts" },
      sessionId: "s1",
      timestamp: "2024-01-01T00:00:00.000Z",
    });

    expect(lines[0]).toContain("[tool_call]");
    expect(lines[0]).toContain("read_file");
  });

  it("formats phase_changed entries", () => {
    const bus = new ExtensionEventBus();
    const { lines } = captureChannel(bus);

    bus.publish({
      type: "phase_changed",
      fromPhase: "proposal",
      toPhase: "design",
      timestamp: "2024-01-01T00:00:00.000Z",
    });

    expect(lines[0]).toContain("[phase_changed]");
    expect(lines[0]).toContain("proposal");
    expect(lines[0]).toContain("design");
  });

  it("formats checkpoint_triggered entries", () => {
    const bus = new ExtensionEventBus();
    const { lines } = captureChannel(bus);

    bus.publish({
      type: "checkpoint_triggered",
      artifactId: "spec-1",
      reason: "human review required",
      sessionId: "s1",
      timestamp: "2024-01-01T00:00:00.000Z",
    });

    expect(lines[0]).toContain("[checkpoint_presented]");
    expect(lines[0]).toContain("spec-1");
    expect(lines[0]).toContain("human review required");
  });

  it("formats checkpoint_resolved entries", () => {
    const bus = new ExtensionEventBus();
    const { lines } = captureChannel(bus);

    bus.publish({
      type: "checkpoint_resolved",
      decision: "proceed",
      artifactId: "spec-1",
      outcome: "human-approved",
      timestamp: "2024-01-01T00:00:00.000Z",
    });

    expect(lines[0]).toContain("[checkpoint_resolved]");
    expect(lines[0]).toContain("proceed");
    expect(lines[0]).toContain("human-approved");
  });

  it("formats session_changed entries", () => {
    const bus = new ExtensionEventBus();
    const { lines } = captureChannel(bus);

    bus.publish({ type: "session_changed", sessionId: "abc-123" });

    expect(lines[0]).toContain("[session_changed]");
    expect(lines[0]).toContain("abc-123");
  });

  it("formats connection_state entries", () => {
    const bus = new ExtensionEventBus();
    const { lines } = captureChannel(bus);

    bus.publish({ type: "connection_state", state: "connected" });

    expect(lines[0]).toContain("[connection_state]");
    expect(lines[0]).toContain("connected");
  });

  it("respects filter — filtered types are not appended", () => {
    const bus = new ExtensionEventBus();
    const { channel, lines } = captureChannel(bus);

    channel.filter.setFilter(["phase_changed"]);

    bus.publish({ type: "connection_state", state: "connected" });
    bus.publish({ type: "phase_changed", fromPhase: "proposal", toPhase: "design", timestamp: "2024-01-01T00:00:00Z" });

    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("[phase_changed]");
  });

  it("showAll re-enables all types", () => {
    const bus = new ExtensionEventBus();
    const { channel, lines } = captureChannel(bus);

    channel.filter.setFilter([]);
    bus.publish({ type: "connection_state", state: "idle" });
    expect(lines).toHaveLength(0);

    channel.filter.showAll();
    bus.publish({ type: "connection_state", state: "connected" });
    expect(lines).toHaveLength(1);
  });
});
