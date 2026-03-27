import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { execFile } from "child_process";
import { promisify } from "util";
import { ImplementationPhase } from "../src/phases/implementation.js";
import { SessionManager } from "../src/core/session.js";
import { AuditLogger } from "../src/core/audit.js";
import { HumanCheckpoint } from "../src/core/checkpoint.js";
import { AgentRegistry } from "../src/core/registry.js";
import { SpawnTracker } from "../src/core/spawn-tracker.js";
import type { PhaseContext } from "../src/phases/base.js";
import type { AgentMessage, TaskAssignment } from "../src/schema.js";
import type { AgentToolsContext, AgentInvokeFn } from "../src/server/tools/agents.js";

const execFileAsync = promisify(execFile);

// Registry with implementer + reviewer agents
const testAgents = {
  implementer: { cli: "codex", canReview: true, canRevise: true, canImplement: true, allowSubInvocation: false },
  reviewer: { cli: "claude", canReview: true, canRevise: true, canImplement: false, allowSubInvocation: false },
};

let tmpDir: string;
let repoRoot: string;
let session: SessionManager;
let logger: AuditLogger;
let checkpoint: HumanCheckpoint;
let agentCtx: AgentToolsContext;

async function patchResponse(commitMessage: string, nextValue: string): Promise<string> {
  const fixtureRepo = await mkdtemp(join(tmpDir, "patch-fixture-"));
  await git(["init"], fixtureRepo);
  await git(["config", "user.email", "fixture@example.com"], fixtureRepo);
  await git(["config", "user.name", "Fixture User"], fixtureRepo);
  await writeFile(join(fixtureRepo, "app.txt"), "old\n", "utf8");
  await git(["add", "app.txt"], fixtureRepo);
  await git(["commit", "-m", "base"], fixtureRepo);
  await writeFile(join(fixtureRepo, "app.txt"), `${nextValue}\n`, "utf8");
  const stdout = await git(["diff", "--", "app.txt"], fixtureRepo);
  return [`Commit message: ${commitMessage}`, "", "```diff", stdout.trimEnd(), "```"].join("\n");
}

async function git(args: string[], cwd: string): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd });
  return stdout.trim();
}

function makeMessage(
  agentId: string,
  phase: "implementation" | "review",
  action: AgentMessage["action"],
  artifactId: string,
  round: number,
  content: string
): AgentMessage {
  return { version: "1", role: agentId, phase, action, artifactId, round, content };
}

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "implementation-test-"));
  repoRoot = join(tmpDir, "repo");
  await execFileAsync("mkdir", ["-p", repoRoot]);

  await git(["init"], repoRoot);
  await git(["config", "user.email", "test@example.com"], repoRoot);
  await git(["config", "user.name", "Test User"], repoRoot);

  await writeFile(join(repoRoot, "app.txt"), "old\n", "utf8");
  await git(["add", "app.txt"], repoRoot);
  await git(["commit", "-m", "initial"], repoRoot);
  await git(["checkout", "-b", "teaming-session"], repoRoot);

  session = await SessionManager.create(tmpDir);
  logger = new AuditLogger(tmpDir, session.get().sessionId);
  checkpoint = new HumanCheckpoint(logger, session.get().sessionId, "proceed");

  const registry = new AgentRegistry(testAgents);
  const spawnTracker = new SpawnTracker({ maxDepth: 2, maxConcurrentSubInvocations: 5, maxSessionInvocations: 50 });
  agentCtx = { registry, spawnTracker, timeoutMs: 120_000, logger, sessionId: session.get().sessionId, phase: "implementation", checkpoint };
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

function makePhaseContext(): PhaseContext {
  return {
    session,
    logger,
    checkpoint,
    consensus: {} as PhaseContext["consensus"],
    registry: new AgentRegistry(testAgents),
  };
}

describe("ImplementationPhase", () => {
  it("creates an isolated worktree and integrates an approved patch", async () => {
    // Task uses registry agent IDs: implementer as primary, reviewer as reviewing
    const assignment: TaskAssignment = {
      taskId: "1.1",
      description: "Update app.txt",
      primaryAgent: "implementer",
      reviewingAgent: "reviewer",
    };

    const invokeAgent: AgentInvokeFn = async (_ctx, params) => {
      if (params.agentId === "implementer") {
        return makeMessage("implementer", "implementation", "implement", params.artifactId, params.round,
          await patchResponse("Update app text", "new"));
      }
      return makeMessage("reviewer", "review", "approve", params.artifactId, params.round, "Looks good.");
    };

    const phase = new ImplementationPhase(makePhaseContext(), { repoRoot, sessionBranch: "teaming-session" }, agentCtx, { invokeAgent });
    await phase.run([assignment]);

    expect(await readFile(join(repoRoot, "app.txt"), "utf8")).toBe("new\n");
    expect(session.get().taskWorktrees["1.1"]?.status).toBe("integrated");
  });

  it("re-applies a revised patch when the reviewer requests changes", async () => {
    const assignment: TaskAssignment = {
      taskId: "1.2",
      description: "Revise app.txt",
      primaryAgent: "implementer",
      reviewingAgent: "reviewer",
    };

    let implementationRound = 0;
    let reviewRound = 0;

    const invokeAgent: AgentInvokeFn = async (_ctx, params) => {
      if (params.agentId === "implementer") {
        implementationRound += 1;
        return makeMessage("implementer", "implementation", "implement", params.artifactId, params.round,
          implementationRound === 1
            ? await patchResponse("First attempt", "first")
            : await patchResponse("Final attempt", "final"));
      }
      reviewRound += 1;
      return reviewRound === 1
        ? makeMessage("reviewer", "review", "request-changes", params.artifactId, params.round, "Please change to 'final'.")
        : makeMessage("reviewer", "review", "approve", params.artifactId, params.round, "Approved.");
    };

    const phase = new ImplementationPhase(makePhaseContext(), { repoRoot, sessionBranch: "teaming-session" }, agentCtx, { invokeAgent });
    await phase.run([assignment]);

    expect(await readFile(join(repoRoot, "app.txt"), "utf8")).toBe("final\n");
    expect(implementationRound).toBe(2);
  });

  it("11.5 — sequential tasks each get their own worktree", async () => {
    const assignments: TaskAssignment[] = [
      { taskId: "seq-a", description: "Add file-a.txt", primaryAgent: "implementer", reviewingAgent: "reviewer" },
      { taskId: "seq-b", description: "Add file-b.txt", primaryAgent: "implementer", reviewingAgent: "reviewer" },
    ];

    const worktreesDuringTask: Record<string, string[]> = {};

    const invokeAgent: AgentInvokeFn = async (_ctx, params) => {
      if (params.agentId === "implementer") {
        const { stdout } = await execFileAsync("git", ["worktree", "list", "--porcelain"], { cwd: repoRoot });
        worktreesDuringTask[params.artifactId] = stdout
          .split("\n")
          .filter((l) => l.startsWith("worktree "))
          .map((l) => l.replace("worktree ", "").trim());

        const filename = params.artifactId === "seq-a" ? "file-a.txt" : "file-b.txt";
        const patch = [
          `diff --git a/${filename} b/${filename}`,
          `new file mode 100644`,
          `--- /dev/null`,
          `+++ b/${filename}`,
          `@@ -0,0 +1 @@`,
          `+content`,
          "",
        ].join("\n");
        return makeMessage("implementer", "implementation", "implement", params.artifactId, params.round,
          `Commit message: Add ${filename}\n\`\`\`diff\n${patch}\`\`\``);
      }
      return makeMessage("reviewer", "review", "approve", params.artifactId, params.round, "LGTM");
    };

    const phase = new ImplementationPhase(makePhaseContext(), { repoRoot, sessionBranch: "teaming-session" }, agentCtx, { invokeAgent });
    await phase.run(assignments);

    expect(await readFile(join(repoRoot, "file-a.txt"), "utf8")).toContain("content");
    expect(await readFile(join(repoRoot, "file-b.txt"), "utf8")).toContain("content");
    expect(worktreesDuringTask["seq-a"]).toHaveLength(2);
    expect(worktreesDuringTask["seq-b"]).toHaveLength(2);

    const { stdout } = await execFileAsync("git", ["worktree", "list", "--porcelain"], { cwd: repoRoot });
    const finalWorktrees = stdout.split("\n").filter((l) => l.startsWith("worktree "));
    expect(finalWorktrees).toHaveLength(1);

    expect(session.get().taskWorktrees["seq-a"]?.status).toBe("integrated");
    expect(session.get().taskWorktrees["seq-b"]?.status).toBe("integrated");
  });

  it("11.6 — conflict replay: rebases task branch onto moved session branch and re-reviews", async () => {
    let reviewCallCount = 0;
    let sessionBranchAdvanced = false;

    const invokeAgent: AgentInvokeFn = async (_ctx, params) => {
      if (params.agentId === "implementer") {
        return makeMessage("implementer", "implementation", "implement", params.artifactId, params.round,
          await patchResponse("Update app text from task", "new-from-task"));
      }
      reviewCallCount++;
      if (!sessionBranchAdvanced) {
        sessionBranchAdvanced = true;
        await writeFile(join(repoRoot, "other.txt"), "other task\n", "utf8");
        await git(["add", "other.txt"], repoRoot);
        await git(["commit", "-m", "concurrent task landed"], repoRoot);
      }
      return makeMessage("reviewer", "review", "approve", params.artifactId, params.round, "Approved.");
    };

    const phase = new ImplementationPhase(makePhaseContext(), { repoRoot, sessionBranch: "teaming-session" }, agentCtx, { invokeAgent });
    await phase.run([{ taskId: "replay", description: "Edit app.txt", primaryAgent: "implementer", reviewingAgent: "reviewer" }]);

    expect(await readFile(join(repoRoot, "app.txt"), "utf8")).toBe("new-from-task\n");
    expect(await readFile(join(repoRoot, "other.txt"), "utf8")).toBe("other task\n");
    expect(session.get().taskWorktrees["replay"]?.status).toBe("integrated");
  });
});
