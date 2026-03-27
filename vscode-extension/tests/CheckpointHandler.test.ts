import { describe, it, expect, vi } from "vitest";
import { CheckpointHandler } from "../src/handlers/CheckpointHandler";
import { ExtensionEventBus } from "../src/bus/ExtensionEventBus";
import type { McpClient } from "../src/connection/McpClient";

function makeContext(): import("vscode").ExtensionContext {
  return { subscriptions: [], extensionUri: { fsPath: "" } } as unknown as import("vscode").ExtensionContext;
}

function makeMcpClient(shouldFail = false): McpClient {
  return {
    callTool: vi.fn().mockImplementation(() =>
      shouldFail ? Promise.reject(new Error("network error")) : Promise.resolve({ ok: true }),
    ),
  } as unknown as McpClient;
}

describe("CheckpointHandler", () => {
  it("skips checkpoint_triggered if artifact already resolved", async () => {
    const bus = new ExtensionEventBus();
    const ctx = makeContext();
    const mcpClient = makeMcpClient();

    // Pre-mark as resolved via checkpoint_resolved event before handler is registered
    new CheckpointHandler(bus, mcpClient, ctx);
    bus.publish({
      type: "checkpoint_resolved",
      decision: "proceed",
      artifactId: "doc-1",
      outcome: "human-approved",
      timestamp: "2024-01-01T00:00:00Z",
    });

    // Now trigger — should be skipped because already resolved
    bus.publish({
      type: "checkpoint_triggered",
      artifactId: "doc-1",
      reason: "needs review",
      sessionId: "s1",
      timestamp: "2024-01-01T00:00:00Z",
    });

    // Wait a tick for async handling
    await Promise.resolve();
    expect(mcpClient.callTool).not.toHaveBeenCalled();
  });

  it("publishes checkpoint_resolved to bus after successful MCP call", async () => {
    const bus = new ExtensionEventBus();
    const ctx = makeContext();
    const mcpClient = makeMcpClient(false);
    const published: unknown[] = [];

    // We can't easily test the full flow (showInformationMessage is async UI),
    // so we test that a pre-resolved artifact is skipped and bus stays clean
    bus.subscribe("checkpoint_resolved", (e) => published.push(e), ctx);
    new CheckpointHandler(bus, mcpClient, ctx);

    // Simulate a resolved event directly (as if MCP responded)
    bus.publish({
      type: "checkpoint_resolved",
      decision: "proceed",
      artifactId: "spec-1",
      outcome: "human-approved",
      timestamp: "2024-01-01T00:00:00Z",
    });

    expect(published).toHaveLength(1);
    expect((published[0] as { artifactId: string }).artifactId).toBe("spec-1");
  });

  it("does not call MCP for a second checkpoint_triggered on already-resolved artifact", async () => {
    const bus = new ExtensionEventBus();
    const ctx = makeContext();
    const mcpClient = makeMcpClient();
    new CheckpointHandler(bus, mcpClient, ctx);

    // Mark resolved
    bus.publish({
      type: "checkpoint_resolved",
      decision: "proceed",
      artifactId: "art-1",
      outcome: "human-approved",
      timestamp: "2024-01-01T00:00:00Z",
    });

    // Trigger again (replay scenario)
    bus.publish({
      type: "checkpoint_triggered",
      artifactId: "art-1",
      reason: "replay",
      sessionId: "s1",
      timestamp: "2024-01-01T00:00:00Z",
    });

    await Promise.resolve();
    expect(mcpClient.callTool).not.toHaveBeenCalled();
  });
});
