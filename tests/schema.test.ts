import { describe, it, expect } from "vitest";
import { AgentMessage, AgentRole, ConsensusAction, WorkflowPhase, ArtifactOutcome, SessionState } from "../src/schema.js";

const validMessage = {
  version: "1" as const,
  role: "claude" as const,
  phase: "proposal" as const,
  action: "approve" as const,
  content: "LGTM",
  artifactId: "proposal-v1",
  round: 0,
};

describe("AgentMessage", () => {
  it("parses a valid message", () => {
    expect(AgentMessage.parse(validMessage)).toEqual(validMessage);
  });

  it("rejects unknown version", () => {
    expect(() => AgentMessage.parse({ ...validMessage, version: "2" })).toThrow();
  });

  it("accepts any string as role (open agent ID)", () => {
    const msg = AgentMessage.parse({ ...validMessage, role: "gpt" });
    expect(msg.role).toBe("gpt");
  });

  it("rejects unknown phase", () => {
    expect(() => AgentMessage.parse({ ...validMessage, phase: "archive" })).toThrow();
  });

  it("rejects unknown action", () => {
    expect(() => AgentMessage.parse({ ...validMessage, action: "delete" })).toThrow();
  });

  it("rejects negative round", () => {
    expect(() => AgentMessage.parse({ ...validMessage, round: -1 })).toThrow();
  });

  it("rejects missing required fields", () => {
    const { content: _content, ...incomplete } = validMessage;
    expect(() => AgentMessage.parse(incomplete)).toThrow();
  });
});

describe("ConsensusAction", () => {
  it("parses all valid values", () => {
    expect(ConsensusAction.parse("approve")).toBe("approve");
    expect(ConsensusAction.parse("request-changes")).toBe("request-changes");
    expect(ConsensusAction.parse("block")).toBe("block");
  });

  it("rejects unknown value", () => {
    expect(() => ConsensusAction.parse("merge")).toThrow();
  });
});

describe("WorkflowPhase", () => {
  const phases = ["proposal", "design", "spec", "task", "implementation", "review"];
  it.each(phases)("accepts %s", (phase) => {
    expect(WorkflowPhase.parse(phase)).toBe(phase);
  });

  it("rejects unknown phase", () => {
    expect(() => WorkflowPhase.parse("testing")).toThrow();
  });
});

describe("AgentRole", () => {
  it("accepts any string (open agent ID — no fixed enum)", () => {
    expect(AgentRole.parse("architect")).toBe("architect");
    expect(AgentRole.parse("security")).toBe("security");
    expect(AgentRole.parse("coordinator")).toBe("coordinator");
    expect(AgentRole.parse("human")).toBe("human");
    // Any string is valid — agentId is now registry-driven
    expect(AgentRole.parse("gemini")).toBe("gemini");
  });
});

describe("ArtifactOutcome", () => {
  it("accepts all valid outcomes", () => {
    expect(ArtifactOutcome.parse("consensus-reached")).toBe("consensus-reached");
    expect(ArtifactOutcome.parse("human-approved")).toBe("human-approved");
    expect(ArtifactOutcome.parse("aborted")).toBe("aborted");
    expect(ArtifactOutcome.parse("pending")).toBe("pending");
  });
});

describe("SessionState", () => {
  it("parses a minimal valid state", () => {
    const state = {
      sessionId: "sess-123",
      currentPhase: "proposal",
      artifactOutcomes: {},
      snapshotIds: {},
      revisionRounds: {},
      taskAssignments: [],
      taskWorktrees: {},
      checkpointPending: false,
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    expect(SessionState.parse(state)).toMatchObject({ sessionId: "sess-123" });
  });
});
