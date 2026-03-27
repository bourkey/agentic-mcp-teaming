import { describe, it, expect, vi } from "vitest";
import { ExtensionEventBus } from "../src/bus/ExtensionEventBus";

function makeContext(): import("vscode").ExtensionContext {
  return { subscriptions: [], extensionUri: { fsPath: "" } } as unknown as import("vscode").ExtensionContext;
}

describe("ExtensionEventBus", () => {
  it("dispatches typed events to subscribers", () => {
    const bus = new ExtensionEventBus();
    const ctx = makeContext();
    const received: unknown[] = [];

    bus.subscribe("session_changed", (e) => received.push(e), ctx);
    bus.publish({ type: "session_changed", sessionId: "abc" });

    expect(received).toHaveLength(1);
    expect((received[0] as { sessionId: string }).sessionId).toBe("abc");
  });

  it("supports multiple subscribers for the same event type", () => {
    const bus = new ExtensionEventBus();
    const ctx = makeContext();
    const calls: string[] = [];

    bus.subscribe("connection_state", () => calls.push("a"), ctx);
    bus.subscribe("connection_state", () => calls.push("b"), ctx);
    bus.publish({ type: "connection_state", state: "connected" });

    expect(calls).toEqual(["a", "b"]);
  });

  it("does not dispatch events to unrelated subscribers", () => {
    const bus = new ExtensionEventBus();
    const ctx = makeContext();
    const received: unknown[] = [];

    bus.subscribe("agent_turn", (e) => received.push(e), ctx);
    bus.publish({ type: "session_changed", sessionId: "xyz" });

    expect(received).toHaveLength(0);
  });

  it("registers disposable in context.subscriptions", () => {
    const bus = new ExtensionEventBus();
    const ctx = makeContext();

    bus.subscribe("phase_changed", () => {}, ctx);

    expect(ctx.subscriptions.length).toBeGreaterThan(0);
  });

  it("stops dispatching after disposable is disposed", () => {
    const bus = new ExtensionEventBus();
    const ctx = makeContext();
    const received: unknown[] = [];

    bus.subscribe("connection_state", (e) => received.push(e), ctx);
    // Dispose all subscriptions via context
    for (const d of ctx.subscriptions) d.dispose();

    bus.publish({ type: "connection_state", state: "idle" });
    expect(received).toHaveLength(0);
  });
});
