import { describe, it, expect, beforeEach } from "vitest";
import { SpawnTracker } from "../src/core/spawn-tracker.js";
import { AgentRegistry } from "../src/core/registry.js";
import type { InvocationContext } from "../src/schema.js";

const spawning = {
  maxDepth: 2,
  maxConcurrentSubInvocations: 3,
  maxSessionInvocations: 10,
};

const agents = {
  architect: { cli: "claude", canReview: true, canRevise: true, canImplement: false, allowSubInvocation: true },
  implementer: { cli: "codex", canReview: true, canRevise: true, canImplement: true, allowSubInvocation: false },
};

let registry: AgentRegistry;
let tracker: SpawnTracker;

function ctx(depth: number, parentId: string | null = null): InvocationContext {
  return { invocationId: `id-${depth}-${Math.random()}`, parentInvocationId: parentId, depth };
}

beforeEach(() => {
  registry = new AgentRegistry(agents);
  tracker = new SpawnTracker(spawning);
});

describe("SpawnTracker — tasks 4.6 + 7.5", () => {
  it("allows a known agent within depth", () => {
    const result = tracker.check(ctx(1), "architect", registry, "coordinator");
    expect(result.allowed).toBe(true);
    expect(result.shouldEscalate).toBe(false);
  });

  it("rejects unknown agent with reason unknown-agent, no escalate", () => {
    const result = tracker.check(ctx(1), "ghost", registry, "coordinator");
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe("unknown-agent");
    expect(result.shouldEscalate).toBe(false);
  });

  it("rejects at exactly maxDepth + 1 and should escalate", () => {
    const parent = ctx(1);
    tracker.beginInvocation(parent, "coordinator", "architect", true);
    const result = tracker.check(ctx(spawning.maxDepth + 1, parent.invocationId), "architect", registry, "agent");
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe("depth-limit-exceeded");
    expect(result.shouldEscalate).toBe(true);
  });

  it("allows at exactly maxDepth", () => {
    const parent = ctx(1);
    tracker.beginInvocation(parent, "coordinator", "architect", true);
    const result = tracker.check(ctx(spawning.maxDepth, parent.invocationId), "architect", registry, "agent");
    expect(result.allowed).toBe(true);
  });

  it("enforces delegated concurrent cap for agent-initiated calls", () => {
    const parent = ctx(1);
    tracker.beginInvocation(parent, "coordinator", "architect", true);
    // Fill up activeCount
    for (let i = 0; i < spawning.maxConcurrentSubInvocations; i++) {
      tracker.beginInvocation(ctx(2, parent.invocationId), "agent", "architect", true);
    }
    const result = tracker.check(ctx(2, parent.invocationId), "architect", registry, "agent");
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe("concurrent-limit-reached");
    expect(result.shouldEscalate).toBe(false);
  });

  it("coordinator review batch is exempt from delegated concurrent cap", () => {
    const parent = ctx(1);
    tracker.beginInvocation(parent, "coordinator", "architect", true);
    // Even if activeCount is at max...
    for (let i = 0; i < spawning.maxConcurrentSubInvocations; i++) {
      tracker.beginInvocation(ctx(2, parent.invocationId), "agent", "architect", true);
    }
    // Coordinator-sourced calls still pass
    const result = tracker.check(ctx(1), "architect", registry, "coordinator");
    expect(result.allowed).toBe(true);
  });

  it("rejects when session budget is exhausted and should escalate", () => {
    for (let i = 0; i < spawning.maxSessionInvocations; i++) {
      tracker.beginInvocation(ctx(1), "coordinator", "architect", true);
    }
    const result = tracker.check(ctx(1), "architect", registry, "coordinator");
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe("session-budget-exhausted");
    expect(result.shouldEscalate).toBe(true);
  });

  it("allows exactly at maxSessionInvocations - 1 total calls", () => {
    for (let i = 0; i < spawning.maxSessionInvocations - 1; i++) {
      tracker.beginInvocation(ctx(1), "coordinator", "architect", true);
    }
    const result = tracker.check(ctx(1), "architect", registry, "coordinator");
    expect(result.allowed).toBe(true);
  });

  it("returns true from beginInvocation exactly at 80% threshold", () => {
    const threshold = Math.floor(spawning.maxSessionInvocations * 0.8);
    for (let i = 0; i < threshold - 1; i++) {
      const warned = tracker.beginInvocation(ctx(1), "coordinator", "architect", true);
      expect(warned).toBe(false);
    }
    const atThreshold = tracker.beginInvocation(ctx(1), "coordinator", "architect", true);
    expect(atThreshold).toBe(true);
  });

  it("decrements activeCount on endInvocation for agent source", () => {
    const first = ctx(2, "root");
    const second = ctx(2, "root");
    tracker.beginInvocation(first, "agent", "architect", true);
    tracker.beginInvocation(second, "agent", "architect", true);
    expect(tracker.getStats().activeCount).toBe(2);
    tracker.endInvocation(first, "agent");
    expect(tracker.getStats().activeCount).toBe(1);
  });

  it("does not decrement below zero", () => {
    tracker.endInvocation(ctx(2, "root"), "agent");
    expect(tracker.getStats().activeCount).toBe(0);
  });

  it("rejects delegated calls when parent invocation is not active", () => {
    const result = tracker.check(ctx(2, "missing-parent"), "architect", registry, "agent");
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe("sub-invocation-not-permitted");
  });

  it("rejects delegated calls when parent agent is not allowed to sub-invoke", () => {
    const parent = ctx(1);
    tracker.beginInvocation(parent, "coordinator", "implementer", false);
    const result = tracker.check(ctx(2, parent.invocationId), "architect", registry, "agent");
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe("sub-invocation-not-permitted");
  });

  it("allows delegated calls when parent invocation is active and permitted", () => {
    const parent = ctx(1);
    tracker.beginInvocation(parent, "coordinator", "architect", true);
    const result = tracker.check(ctx(2, parent.invocationId), "architect", registry, "agent");
    expect(result.allowed).toBe(true);
  });

  it("restores stats from session (for resume)", () => {
    const restored = new SpawnTracker(spawning, { activeCount: 2, sessionTotal: 7 });
    expect(restored.getStats().activeCount).toBe(2);
    expect(restored.getStats().sessionTotal).toBe(7);
  });
});
