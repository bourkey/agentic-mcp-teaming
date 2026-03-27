import type { InvocationContext } from "../schema.js";
import type { AgentRegistry } from "./registry.js";
import type { McpConfig } from "../config.js";

export interface SpawnCheckResult {
  allowed: boolean;
  reason?: string;
  shouldEscalate: boolean;
}

export class SpawnTracker {
  private activeCount: number;
  private sessionTotal: number;
  private readonly activeInvocations = new Map<string, { agentId: string; allowSubInvocation: boolean }>();
  private readonly maxDepth: number;
  private readonly maxConcurrent: number;
  private readonly maxSession: number;

  constructor(spawning: McpConfig["spawning"], initial?: { activeCount: number; sessionTotal: number }) {
    this.maxDepth = spawning.maxDepth;
    this.maxConcurrent = spawning.maxConcurrentSubInvocations;
    this.maxSession = spawning.maxSessionInvocations;
    this.activeCount = initial?.activeCount ?? 0;
    this.sessionTotal = initial?.sessionTotal ?? 0;
  }

  check(
    invocationContext: InvocationContext,
    agentId: string,
    registry: AgentRegistry,
    source: "coordinator" | "agent"
  ): SpawnCheckResult {
    if (!registry.get(agentId)) {
      return { allowed: false, reason: "unknown-agent", shouldEscalate: false };
    }

    if (source === "agent") {
      const parentId = invocationContext.parentInvocationId;
      const parent = parentId ? this.activeInvocations.get(parentId) : undefined;
      if (!parent || !parent.allowSubInvocation) {
        return { allowed: false, reason: "sub-invocation-not-permitted", shouldEscalate: false };
      }
    }

    if (invocationContext.depth > this.maxDepth) {
      return { allowed: false, reason: "depth-limit-exceeded", shouldEscalate: true };
    }

    if (source === "agent" && this.activeCount >= this.maxConcurrent) {
      return { allowed: false, reason: "concurrent-limit-reached", shouldEscalate: false };
    }

    if (this.sessionTotal >= this.maxSession) {
      return { allowed: false, reason: "session-budget-exhausted", shouldEscalate: true };
    }

    return { allowed: true, shouldEscalate: false };
  }

  beginInvocation(
    invocationContext: InvocationContext,
    source: "coordinator" | "agent",
    agentId: string,
    allowSubInvocation: boolean
  ): boolean {
    this.sessionTotal++;
    if (source === "agent") this.activeCount++;
    this.activeInvocations.set(invocationContext.invocationId, { agentId, allowSubInvocation });
    return this.sessionTotal === Math.floor(this.maxSession * 0.8);
  }

  endInvocation(invocationContext: InvocationContext, source: "coordinator" | "agent"): void {
    if (source === "agent" && this.activeCount > 0) this.activeCount--;
    this.activeInvocations.delete(invocationContext.invocationId);
  }

  getStats(): { activeCount: number; sessionTotal: number } {
    return { activeCount: this.activeCount, sessionTotal: this.sessionTotal };
  }
}
