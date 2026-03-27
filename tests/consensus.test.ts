import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { ConsensusLoop, evaluateConsensus, aggregateFeedback } from "../src/core/consensus.js";
import { SessionManager } from "../src/core/session.js";
import { AuditLogger } from "../src/core/audit.js";
import { SnapshotStore } from "../src/core/snapshot.js";
import { HumanCheckpoint } from "../src/core/checkpoint.js";
import { AgentRegistry } from "../src/core/registry.js";
import { SpawnTracker } from "../src/core/spawn-tracker.js";
import type { AgentMessage } from "../src/schema.js";
import type { AgentToolsContext, AgentInvokeFn } from "../src/server/tools/agents.js";

const testAgents = {
  architect: { cli: "claude", canReview: true, canRevise: true, canImplement: false, allowSubInvocation: false },
  security: { cli: "claude", canReview: true, canRevise: false, canImplement: false, allowSubInvocation: false },
  implementer: { cli: "codex", canReview: true, canRevise: true, canImplement: true, allowSubInvocation: false },
};

let tmpDir: string;
let session: SessionManager;
let logger: AuditLogger;
let snapshots: SnapshotStore;
let agentCtx: AgentToolsContext;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "consensus-test-"));
  session = await SessionManager.create(tmpDir);
  const { sessionId } = session.get();
  logger = new AuditLogger(tmpDir, sessionId);
  snapshots = new SnapshotStore(tmpDir, sessionId);
  const registry = new AgentRegistry(testAgents);
  const spawnTracker = new SpawnTracker({ maxDepth: 2, maxConcurrentSubInvocations: 5, maxSessionInvocations: 50 });
  const checkpoint = new HumanCheckpoint(logger, sessionId, "proceed");
  agentCtx = { registry, spawnTracker, timeoutMs: 5000, logger, sessionId, phase: "proposal", checkpoint };
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

function mockInvoke(actions: Record<string, AgentMessage["action"]>): AgentInvokeFn {
  return async (_ctx, params) => ({
    version: "1",
    role: params.agentId,
    phase: "proposal",
    action: actions[params.agentId] ?? "approve",
    content: `[mock ${params.agentId}]`,
    artifactId: params.artifactId,
    round: params.round,
  });
}

function makeLoop(
  actions: Record<string, AgentMessage["action"]>,
  reviewerIds: string[],
  autoDecide: "proceed" | "abort" = "proceed"
): ConsensusLoop {
  const checkpoint = new HumanCheckpoint(logger, session.get().sessionId, autoDecide);
  return new ConsensusLoop(agentCtx, session, logger, snapshots, checkpoint, {
    maxRounds: 3,
    reviewerAgentIds: reviewerIds,
    reviserAgentId: "architect",
    invokeAgent: mockInvoke(actions),
  });
}

describe("evaluateConsensus — N-agent unanimous", () => {
  it("returns consensus-reached when all approve", () => {
    const msgs: AgentMessage[] = [
      { version: "1", role: "a", phase: "proposal", action: "approve", content: "ok", artifactId: "x", round: 0 },
      { version: "1", role: "b", phase: "proposal", action: "approve", content: "ok", artifactId: "x", round: 0 },
      { version: "1", role: "c", phase: "proposal", action: "approve", content: "ok", artifactId: "x", round: 0 },
    ];
    expect(evaluateConsensus(msgs)).toBe("consensus-reached");
  });

  it("returns block if any agent blocks", () => {
    const msgs: AgentMessage[] = [
      { version: "1", role: "a", phase: "proposal", action: "approve", content: "", artifactId: "x", round: 0 },
      { version: "1", role: "b", phase: "proposal", action: "block", content: "NO", artifactId: "x", round: 0 },
    ];
    expect(evaluateConsensus(msgs)).toBe("block");
  });

  it("returns needs-revision when some approve and some request-changes", () => {
    const msgs: AgentMessage[] = [
      { version: "1", role: "a", phase: "proposal", action: "approve", content: "", artifactId: "x", round: 0 },
      { version: "1", role: "b", phase: "proposal", action: "request-changes", content: "fix this", artifactId: "x", round: 0 },
    ];
    expect(evaluateConsensus(msgs)).toBe("needs-revision");
  });
});

describe("aggregateFeedback", () => {
  it("formats feedback with round header and per-agent sections", () => {
    const msgs: AgentMessage[] = [
      { version: "1", role: "architect", phase: "proposal", action: "request-changes", content: "Needs more detail", artifactId: "x", round: 1 },
      { version: "1", role: "security", phase: "proposal", action: "request-changes", content: "Add auth checks", artifactId: "x", round: 1 },
    ];
    const result = aggregateFeedback(msgs, 1);
    expect(result).toContain("## Revision Requested — Round 1");
    expect(result).toContain("### From: architect");
    expect(result).toContain("Needs more detail");
    expect(result).toContain("### From: security");
    expect(result).toContain("Add auth checks");
  });

  it("truncates content exceeding per-agent limit", () => {
    const longContent = "x".repeat(3000);
    const msgs: AgentMessage[] = [
      { version: "1", role: "a", phase: "proposal", action: "request-changes", content: longContent, artifactId: "x", round: 0 },
    ];
    const result = aggregateFeedback(msgs, 0, 100);
    expect(result).toContain("[truncated]");
    expect(result.length).toBeLessThan(longContent.length);
  });

  it("excludes approve actions from feedback", () => {
    const msgs: AgentMessage[] = [
      { version: "1", role: "a", phase: "proposal", action: "approve", content: "good", artifactId: "x", round: 0 },
      { version: "1", role: "b", phase: "proposal", action: "request-changes", content: "fix X", artifactId: "x", round: 0 },
    ];
    const result = aggregateFeedback(msgs, 0);
    expect(result).not.toContain("### From: a");
    expect(result).toContain("### From: b");
  });
});

describe("ConsensusLoop — N-agent flow", () => {
  it("reaches consensus when all 3 reviewers approve", async () => {
    const loop = makeLoop(
      { architect: "approve", security: "approve", implementer: "approve" },
      ["architect", "security", "implementer"]
    );
    const result = await loop.run("proposal", "content");
    expect(result.outcome).toBe("consensus-reached");
    expect(result.rounds).toBe(1);
  });

  it("escalates to human immediately when any reviewer blocks", async () => {
    const loop = makeLoop(
      { architect: "approve", security: "block", implementer: "approve" },
      ["architect", "security", "implementer"]
    );
    const result = await loop.run("proposal", "content");
    expect(["human-approved", "aborted"]).toContain(result.outcome);
  });

  it("aggregates feedback from multiple requesting-changes agents", async () => {
    let revisionSeen = false;
    const invokeAgentFn: AgentInvokeFn = async (_ctx, params) => {
      if (params.agentId === "architect" && params.context) {
        revisionSeen = true;
        return { version: "1", role: "architect", phase: "proposal", action: "submit", content: "revised", artifactId: params.artifactId, round: params.round };
      }
      if (params.round === 0) {
        return { version: "1", role: params.agentId, phase: "proposal", action: "request-changes", content: `fix from ${params.agentId}`, artifactId: params.artifactId, round: params.round };
      }
      return { version: "1", role: params.agentId, phase: "proposal", action: "approve", content: "ok", artifactId: params.artifactId, round: params.round };
    };
    const checkpoint = new HumanCheckpoint(logger, session.get().sessionId, "proceed");
    const loop = new ConsensusLoop(agentCtx, session, logger, snapshots, checkpoint, {
      maxRounds: 3,
      reviewerAgentIds: ["security", "implementer"],
      reviserAgentId: "architect",
      invokeAgent: invokeAgentFn,
    });
    await loop.run("proposal", "original");
    expect(revisionSeen).toBe(true);
  });

  it("escalates to human after revision cap with abort → aborted", async () => {
    const loop = makeLoop(
      { architect: "request-changes", security: "request-changes" },
      ["architect", "security"],
      "abort"
    );
    const result = await loop.run("proposal", "content");
    expect(result.outcome).toBe("aborted");
  });

  it("CLI error during review is treated as block", async () => {
    const invokeAgentFn: AgentInvokeFn = async (_ctx, params) => {
      if (params.agentId === "security") throw new Error("CLI crashed");
      return { version: "1", role: params.agentId, phase: "proposal", action: "approve", content: "ok", artifactId: params.artifactId, round: params.round };
    };
    const checkpoint = new HumanCheckpoint(logger, session.get().sessionId, "proceed");
    const loop = new ConsensusLoop(agentCtx, session, logger, snapshots, checkpoint, {
      maxRounds: 3,
      reviewerAgentIds: ["architect", "security"],
      reviserAgentId: "architect",
      invokeAgent: invokeAgentFn,
    });
    const result = await loop.run("proposal", "content");
    expect(["human-approved", "aborted"]).toContain(result.outcome);
  });
});
