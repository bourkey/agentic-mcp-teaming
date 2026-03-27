import { describe, it, expect } from "vitest";
import { makeMockAgentTool, type AgentToolsContext, type AgentInvokeParams } from "../src/server/tools/agents.js";
import { AgentRegistry } from "../src/core/registry.js";
import { SpawnTracker } from "../src/core/spawn-tracker.js";
import { AuditLogger } from "../src/core/audit.js";
import { HumanCheckpoint } from "../src/core/checkpoint.js";
import { tmpdir } from "os";
import { join } from "path";

const testAgents = {
  architect: { cli: "claude", specialty: "design", canReview: true, canRevise: true, canImplement: false, allowSubInvocation: false },
  implementer: { cli: "codex", canReview: true, canRevise: true, canImplement: true, allowSubInvocation: false },
};

function makeCtx(overrides: Partial<AgentToolsContext> = {}): AgentToolsContext {
  const registry = new AgentRegistry(testAgents);
  const spawnTracker = new SpawnTracker({ maxDepth: 2, maxConcurrentSubInvocations: 5, maxSessionInvocations: 50 });
  const logger = new AuditLogger(join(tmpdir(), "test-sessions"), "test-sess");
  const checkpoint = new HumanCheckpoint(logger, "test-sess", "proceed");
  return {
    registry,
    spawnTracker,
    timeoutMs: 5000,
    logger,
    sessionId: "test-sess",
    phase: "proposal",
    checkpoint,
    ...overrides,
  };
}

const params: AgentInvokeParams = {
  agentId: "architect",
  prompt: "Please review this proposal.",
  artifactId: "proposal-v1",
  round: 0,
};

describe("makeMockAgentTool (architect)", () => {
  it("returns approve action by default", async () => {
    const tool = makeMockAgentTool("architect");
    const msg = await tool(makeCtx(), params);
    expect(msg.action).toBe("approve");
    expect(msg.role).toBe("architect");
    expect(msg.artifactId).toBe("proposal-v1");
    expect(msg.round).toBe(0);
    expect(msg.version).toBe("1");
  });

  it("returns configured action", async () => {
    const tool = makeMockAgentTool("architect", "request-changes");
    const msg = await tool(makeCtx(), params);
    expect(msg.action).toBe("request-changes");
  });

  it("returns block action", async () => {
    const tool = makeMockAgentTool("architect", "block");
    const msg = await tool(makeCtx(), params);
    expect(msg.action).toBe("block");
  });
});

describe("makeMockAgentTool (implementer)", () => {
  it("returns approve with implementer role", async () => {
    const tool = makeMockAgentTool("implementer");
    const msg = await tool(makeCtx(), { ...params, agentId: "implementer" });
    expect(msg.role).toBe("implementer");
    expect(msg.action).toBe("approve");
  });
});

describe("agent tool context", () => {
  it("propagates round to returned message", async () => {
    const tool = makeMockAgentTool("architect");
    const msg = await tool(makeCtx(), { ...params, round: 2 });
    expect(msg.round).toBe(2);
  });

  it("propagates artifactId to returned message", async () => {
    const tool = makeMockAgentTool("implementer");
    const msg = await tool(makeCtx(), { ...params, agentId: "implementer", artifactId: "design-v2" });
    expect(msg.artifactId).toBe("design-v2");
  });
});
