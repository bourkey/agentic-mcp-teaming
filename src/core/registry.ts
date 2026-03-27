import type { McpConfig } from "../config.js";

export type AgentEntry = McpConfig["agents"][string];

export class AgentRegistry {
  private readonly entries: Map<string, AgentEntry>;

  constructor(agents: McpConfig["agents"]) {
    this.entries = new Map(Object.entries(agents));

    if (this.entries.size === 0) {
      throw new Error("Agent registry is empty: at least one agent must be configured.");
    }
    if (this.revisers().length === 0) {
      throw new Error("Agent registry has no agents with canRevise: true. At least one revising agent is required.");
    }
    if (this.implementers().length === 0) {
      throw new Error("Agent registry has no agents with canImplement: true. At least one implementing agent is required.");
    }
  }

  get(agentId: string): AgentEntry | undefined {
    return this.entries.get(agentId);
  }

  all(): ReadonlyMap<string, AgentEntry> {
    return this.entries as ReadonlyMap<string, AgentEntry>;
  }

  allowsSubInvocation(agentId: string): boolean {
    return this.entries.get(agentId)?.allowSubInvocation ?? false;
  }

  reviewers(): string[] {
    return [...this.entries.entries()]
      .filter(([, e]) => e.canReview)
      .map(([id]) => id);
  }

  revisers(): string[] {
    return [...this.entries.entries()]
      .filter(([, e]) => e.canRevise)
      .map(([id]) => id);
  }

  implementers(): string[] {
    return [...this.entries.entries()]
      .filter(([, e]) => e.canImplement)
      .map(([id]) => id);
  }
}
