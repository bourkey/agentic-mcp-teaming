import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, readFile } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { SessionManager } from "../src/core/session.js";
import { AuditLogger } from "../src/core/audit.js";
import { SnapshotStore } from "../src/core/snapshot.js";
import { HumanCheckpoint } from "../src/core/checkpoint.js";
import { ConsensusLoop } from "../src/core/consensus.js";
import { AgentRegistry } from "../src/core/registry.js";
import { SpawnTracker } from "../src/core/spawn-tracker.js";
import { makeMockAgentTool, type AgentToolsContext, type AgentInvokeFn } from "../src/server/tools/agents.js";
import { submitForConsensusTool, advancePhaseTool, getSessionStateTool, resolveCheckpointTool, type WorkflowToolsContext } from "../src/server/tools/workflow.js";
import { createCoordinatorServer, extractRequestToken, isAuthorizedRequest } from "../src/server/index.js";
import { loadConfig } from "../src/config.js";

const testAgents = {
  architect: { cli: "claude", canReview: true, canRevise: true, canImplement: false, allowSubInvocation: false },
  implementer: { cli: "codex", canReview: true, canRevise: true, canImplement: true, allowSubInvocation: false },
};

let tmpDir: string;
let session: SessionManager;
let logger: AuditLogger;
let snapshots: SnapshotStore;
let checkpoint: HumanCheckpoint;
let consensusLoop: ConsensusLoop;
let wfCtx: WorkflowToolsContext;
let agentCtx: AgentToolsContext;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "e2e-test-"));
  session = await SessionManager.create(tmpDir);
  const { sessionId } = session.get();
  logger = new AuditLogger(tmpDir, sessionId);
  snapshots = new SnapshotStore(tmpDir, sessionId);
  checkpoint = new HumanCheckpoint(logger, sessionId, "proceed");

  const registry = new AgentRegistry(testAgents);
  const spawnTracker = new SpawnTracker({ maxDepth: 2, maxConcurrentSubInvocations: 5, maxSessionInvocations: 50 });
  agentCtx = { registry, spawnTracker, timeoutMs: 5000, logger, sessionId, phase: "proposal", checkpoint };

  const mockApprove: AgentInvokeFn = async (_ctx, params) => ({
    version: "1",
    role: params.agentId,
    phase: "proposal",
    action: "approve",
    content: "ok",
    artifactId: params.artifactId,
    round: params.round,
  });

  consensusLoop = new ConsensusLoop(agentCtx, session, logger, snapshots, checkpoint, {
    reviewerAgentIds: ["architect", "implementer"],
    reviserAgentId: "architect",
    invokeAgent: mockApprove,
  });
  wfCtx = { session, logger, consensus: consensusLoop };
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

describe("E2E: full proposal → design consensus workflow (dry-run)", () => {
  it("runs proposal through submit_for_consensus and advances phase", async () => {
    const result = await submitForConsensusTool(wfCtx, {
      artifactId: "proposal",
      content: "## Why\nTest proposal for E2E.",
    });
    expect(["consensus-reached", "human-approved"]).toContain(result.outcome);
    expect(session.get().artifactOutcomes["proposal"]).toBeTruthy();
    expect(result.rounds).toBeGreaterThanOrEqual(1);
  });

  it("advances phase after consensus", async () => {
    await session.setArtifactOutcome("proposal", "consensus-reached");
    const advance = await advancePhaseTool(wfCtx, { artifactId: "proposal" });
    expect(advance.newPhase).toBe("design");
    expect(session.get().currentPhase).toBe("design");
  });

  it("can chain proposal → design → spec phase transitions", async () => {
    await session.setArtifactOutcome("proposal", "consensus-reached");
    await advancePhaseTool(wfCtx, { artifactId: "proposal" });
    expect(session.get().currentPhase).toBe("design");

    await session.setArtifactOutcome("design", "consensus-reached");
    await advancePhaseTool(wfCtx, { artifactId: "design" });
    expect(session.get().currentPhase).toBe("spec");
  });
});

describe("E2E: audit log completeness", () => {
  it("records an audit entry for every submit_for_consensus call", async () => {
    await submitForConsensusTool(wfCtx, { artifactId: "proposal", content: "test" });
    await new Promise((r) => setTimeout(r, 50));

    const logPath = join(tmpDir, session.get().sessionId, "audit.log");
    const logContent = await readFile(logPath, "utf8");
    const entries = logContent.trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
    const types = entries.map((e) => e["type"]);
    expect(types).toContain("consensus_start");
    expect(types).toContain("consensus_end");
    expect(entries.every((e) => typeof e["timestamp"] === "string")).toBe(true);
  });
});

describe("E2E: session state persistence and resume", () => {
  it("session state survives a create → update → load round-trip", async () => {
    await session.setPhase("design");
    await session.setArtifactOutcome("proposal", "consensus-reached");
    const loaded = await SessionManager.load(tmpDir, session.get().sessionId);
    expect(loaded.get().currentPhase).toBe("design");
    expect(loaded.get().artifactOutcomes["proposal"]).toBe("consensus-reached");
  });

  it("pre-change sessions backfill spawnStats on load", async () => {
    // Simulate a session created before spawnStats was added
    const sessionId = session.get().sessionId;
    const statePath = join(tmpDir, sessionId, "state.json");
    const raw = JSON.parse(await readFile(statePath, "utf8")) as Record<string, unknown>;
    delete raw["spawnStats"];
    await writeFile(statePath, JSON.stringify(raw), "utf8");

    const loaded = await SessionManager.load(tmpDir, sessionId);
    expect(loaded.get().spawnStats.activeCount).toBe(0);
    expect(loaded.get().spawnStats.sessionTotal).toBe(0);
  });

  it("get_session_state MCP tool returns current state", () => {
    const state = getSessionStateTool(wfCtx);
    expect(state.sessionId).toBe(session.get().sessionId);
    expect(state.currentPhase).toBe("proposal");
  });
});

describe("E2E: human checkpoint resolve via MCP tool", () => {
  it("resolve_checkpoint proceed sets human-approved and clears pending", async () => {
    await session.update({ checkpointPending: true });
    const result = await resolveCheckpointTool(wfCtx, {
      decision: "proceed",
      artifactId: "proposal",
    });
    expect(result.outcome).toBe("human-approved");
    expect(session.get().checkpointPending).toBe(false);
    expect(session.get().artifactOutcomes["proposal"]).toBe("human-approved");
  });

  it("resolve_checkpoint abort throws and sets aborted", async () => {
    await expect(
      resolveCheckpointTool(wfCtx, { decision: "abort", artifactId: "proposal" })
    ).rejects.toThrow();
    expect(session.get().artifactOutcomes["proposal"]).toBe("aborted");
  });
});

describe("E2E: MCP server tool registration (dry-run)", () => {
  it("creates coordinator server with invoke_agent registered (not invoke_claude/invoke_codex)", async () => {
    const configPath = join(tmpDir, "mcp-config.json");
    await writeFile(configPath, JSON.stringify({
      port: 13100,
      rootDir: tmpDir,
      toolAllowlist: ["invoke_agent", "submit_for_consensus", "advance_phase", "get_session_state", "resolve_checkpoint"],
      agents: {
        architect: { cli: "claude", canReview: true, canRevise: true, canImplement: false },
        implementer: { cli: "codex", canReview: true, canRevise: true, canImplement: true },
      },
    }), "utf8");

    const config = loadConfig(configPath);
    const registry = new AgentRegistry(config.agents);
    const spawnTracker = new SpawnTracker(config.spawning);
    const server = createCoordinatorServer({
      config,
      session,
      logger,
      consensus: consensusLoop,
      registry,
      spawnTracker,
      checkpoint,
      dryRun: true,
    });
    expect(server).toBeTruthy();
  });
});

describe("E2E: MCP transport auth", () => {
  it("extracts and validates bearer or query tokens", () => {
    const bearerReq = {
      header: (name: string) => name === "authorization" ? "Bearer secret-token" : undefined,
      query: {},
    };
    const queryReq = {
      header: () => undefined,
      query: { token: "secret-token" },
    };
    const badReq = { header: () => undefined, query: {} };

    expect(extractRequestToken(bearerReq as never)).toBe("secret-token");
    expect(extractRequestToken(queryReq as never)).toBe("secret-token");
    expect(isAuthorizedRequest(bearerReq as never, "secret-token")).toBe(true);
    expect(isAuthorizedRequest(queryReq as never, "secret-token")).toBe(true);
    expect(isAuthorizedRequest(badReq as never, "secret-token")).toBe(false);
  });
});

describe("E2E: snapshot tool output sharing", () => {
  it("snapshot captures tool outputs once and reuses for both agents", async () => {
    const snapshot = await snapshots.capture(
      "proposal",
      "artifact content",
      0,
      { "read_file:readme.md": "# README\nThis is the project." }
    );
    const loaded = await snapshots.load(snapshot.snapshotId);
    expect(loaded.toolOutputs["read_file:readme.md"]).toBe("# README\nThis is the project.");
    expect(loaded.artifactId).toBe("proposal");
    expect(loaded.round).toBe(0);
  });
});
