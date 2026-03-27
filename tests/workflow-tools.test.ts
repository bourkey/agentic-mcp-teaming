import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { SessionManager } from "../src/core/session.js";
import { AuditLogger } from "../src/core/audit.js";
import { advancePhaseTool, getSessionStateTool, resolveCheckpointTool, type WorkflowToolsContext } from "../src/server/tools/workflow.js";

let tmpDir: string;
let session: SessionManager;
let logger: AuditLogger;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "workflow-test-"));
  session = await SessionManager.create(tmpDir);
  logger = new AuditLogger(tmpDir, session.get().sessionId);
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

function makeCtx(): WorkflowToolsContext {
  return { session, logger, consensus: null as unknown as WorkflowToolsContext["consensus"] };
}

describe("getSessionStateTool", () => {
  it("returns current session state", () => {
    const state = getSessionStateTool(makeCtx());
    expect(state.currentPhase).toBe("proposal");
    expect(state.checkpointPending).toBe(false);
  });
});

describe("advancePhaseTool", () => {
  it("advances phase when artifact has consensus-reached outcome", async () => {
    await session.setArtifactOutcome("proposal-v1", "consensus-reached");
    const result = await advancePhaseTool(makeCtx(), { artifactId: "proposal-v1" });
    expect(result.newPhase).toBe("design");
    expect(session.get().currentPhase).toBe("design");
  });

  it("advances phase when artifact has human-approved outcome", async () => {
    await session.setArtifactOutcome("proposal-v1", "human-approved");
    const result = await advancePhaseTool(makeCtx(), { artifactId: "proposal-v1" });
    expect(result.newPhase).toBe("design");
  });

  it("throws when artifact outcome is pending", async () => {
    await expect(
      advancePhaseTool(makeCtx(), { artifactId: "proposal-v1" })
    ).rejects.toThrow("pending");
  });

  it("throws when artifact outcome is aborted", async () => {
    await session.setArtifactOutcome("proposal-v1", "aborted");
    await expect(
      advancePhaseTool(makeCtx(), { artifactId: "proposal-v1" })
    ).rejects.toThrow();
  });
});

describe("resolveCheckpointTool", () => {
  it("proceed returns human-approved outcome", async () => {
    const result = await resolveCheckpointTool(makeCtx(), {
      decision: "proceed",
      artifactId: "design-v1",
    });
    expect(result.outcome).toBe("human-approved");
    expect(session.get().artifactOutcomes["design-v1"]).toBe("human-approved");
  });

  it("abort throws with aborted outcome set", async () => {
    await expect(
      resolveCheckpointTool(makeCtx(), { decision: "abort", artifactId: "design-v1" })
    ).rejects.toThrow("aborted");
    expect(session.get().artifactOutcomes["design-v1"]).toBe("aborted");
  });

  it("clears checkpointPending on proceed", async () => {
    await session.update({ checkpointPending: true });
    await resolveCheckpointTool(makeCtx(), { decision: "proceed" });
    expect(session.get().checkpointPending).toBe(false);
  });
});
