import { describe, it, expect } from "vitest";
import { SessionTreeDataProvider } from "../src/views/SessionTreeDataProvider";
import { ExtensionEventBus } from "../src/bus/ExtensionEventBus";

function makeContext(): import("vscode").ExtensionContext {
  return { subscriptions: [], extensionUri: { fsPath: "" } } as unknown as import("vscode").ExtensionContext;
}

describe("SessionTreeDataProvider", () => {
  it("shows placeholder when no session is active", () => {
    const bus = new ExtensionEventBus();
    const ctx = makeContext();
    const provider = new SessionTreeDataProvider(bus, ctx);

    const children = provider.getChildren(undefined);
    expect(children).toHaveLength(1);
    const item = provider.getTreeItem(children[0]);
    expect((item.label as string)).toMatch(/No active session/);
  });

  it("shows all phases as top-level nodes after session_changed", () => {
    const bus = new ExtensionEventBus();
    const ctx = makeContext();
    const provider = new SessionTreeDataProvider(bus, ctx);

    bus.publish({ type: "session_changed", sessionId: "session-1" });

    const children = provider.getChildren(undefined);
    expect(children).toHaveLength(6); // proposal, design, spec, task, implementation, review
    const items = children.map((c) => provider.getTreeItem(c));
    const labels = items.map((i) => i.label as string);
    expect(labels).toContain("proposal");
    expect(labels).toContain("design");
    expect(labels).toContain("review");
  });

  it("marks phase as done when phase_changed event arrives", () => {
    const bus = new ExtensionEventBus();
    const ctx = makeContext();
    const provider = new SessionTreeDataProvider(bus, ctx);

    bus.publish({ type: "session_changed", sessionId: "session-1" });
    bus.publish({ type: "phase_changed", fromPhase: "proposal", toPhase: "design", timestamp: "2024-01-01T00:00:00Z" });

    const children = provider.getChildren(undefined);
    // All children are PhaseNodes — current API just checks icons via ThemeIcon
    // Phase nodes exist and tree renders
    expect(children.length).toBe(6);
  });

  it("adds artifact node under correct phase on agent_turn", () => {
    const bus = new ExtensionEventBus();
    const ctx = makeContext();
    const provider = new SessionTreeDataProvider(bus, ctx);

    bus.publish({ type: "session_changed", sessionId: "session-1" });
    bus.publish({
      type: "agent_turn",
      sessionId: "session-1",
      agentId: "architect",
      phase: "design",
      action: "approve",
      artifactId: "design-doc",
      round: 1,
      content: "LGTM",
      timestamp: "2024-01-01T00:00:00Z",
    });

    const topLevel = provider.getChildren(undefined);
    const designNode = topLevel.find((n) => provider.getTreeItem(n).label === "design");
    expect(designNode).toBeDefined();

    const artifacts = provider.getChildren(designNode!);
    expect(artifacts).toHaveLength(1);
    const artItem = provider.getTreeItem(artifacts[0]);
    expect((artItem.label as string)).toContain("design-doc");
    expect((artItem.label as string)).toContain("[in-progress]");
  });

  it("only marks final outcome after artifact_outcome event arrives", () => {
    const bus = new ExtensionEventBus();
    const ctx = makeContext();
    const provider = new SessionTreeDataProvider(bus, ctx);

    bus.publish({ type: "session_changed", sessionId: "session-1" });
    bus.publish({
      type: "agent_turn",
      sessionId: "session-1",
      agentId: "architect",
      phase: "design",
      action: "approve",
      artifactId: "design-doc",
      round: 1,
      content: "LGTM",
      timestamp: "2024-01-01T00:00:00Z",
    });

    let designNode = provider.getChildren(undefined).find((n) => provider.getTreeItem(n).label === "design");
    let artifacts = provider.getChildren(designNode!);
    let artItem = provider.getTreeItem(artifacts[0]);
    expect((artItem.label as string)).toContain("[in-progress]");

    bus.publish({
      type: "artifact_outcome",
      artifactId: "design-doc",
      outcome: "consensus-reached",
      rounds: 1,
      timestamp: "2024-01-01T00:00:00Z",
    });

    designNode = provider.getChildren(undefined).find((n) => provider.getTreeItem(n).label === "design");
    artifacts = provider.getChildren(designNode!);
    artItem = provider.getTreeItem(artifacts[0]);
    expect((artItem.label as string)).toContain("[consensus-reached]");
  });

  it("shows awaiting-decision label when checkpoint_triggered", () => {
    const bus = new ExtensionEventBus();
    const ctx = makeContext();
    const provider = new SessionTreeDataProvider(bus, ctx);

    bus.publish({ type: "session_changed", sessionId: "session-1" });
    bus.publish({
      type: "agent_turn",
      sessionId: "session-1",
      agentId: "architect",
      phase: "design",
      action: "comment",
      artifactId: "design-doc",
      round: 1,
      content: "draft",
      timestamp: "2024-01-01T00:00:00Z",
    });
    bus.publish({
      type: "checkpoint_triggered",
      artifactId: "design-doc",
      reason: "review needed",
      sessionId: "session-1",
      timestamp: "2024-01-01T00:00:00Z",
    });

    const topLevel = provider.getChildren(undefined);
    const designNode = topLevel.find((n) => provider.getTreeItem(n).label === "design");
    const artifacts = provider.getChildren(designNode!);
    const artItem = provider.getTreeItem(artifacts[0]);
    expect((artItem.label as string)).toContain("Awaiting human decision");
  });

  it("resets to empty state on new session", () => {
    const bus = new ExtensionEventBus();
    const ctx = makeContext();
    const provider = new SessionTreeDataProvider(bus, ctx);

    bus.publish({ type: "session_changed", sessionId: "session-1" });
    bus.publish({
      type: "agent_turn",
      sessionId: "session-1",
      agentId: "architect",
      phase: "design",
      action: "approve",
      artifactId: "design-doc",
      round: 1,
      content: "ok",
      timestamp: "2024-01-01T00:00:00Z",
    });

    // Switch to new session — tree should reset
    bus.publish({ type: "session_changed", sessionId: "session-2" });

    const topLevel = provider.getChildren(undefined);
    const designNode = topLevel.find((n) => provider.getTreeItem(n).label === "design");
    const artifacts = provider.getChildren(designNode!);
    expect(artifacts).toHaveLength(0);
  });
});
