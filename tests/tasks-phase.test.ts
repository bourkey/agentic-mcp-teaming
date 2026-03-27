import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { SessionManager } from "../src/core/session.js";
import { AuditLogger } from "../src/core/audit.js";
import { HumanCheckpoint } from "../src/core/checkpoint.js";
import { AgentRegistry } from "../src/core/registry.js";
import { runTasksPhase } from "../src/phases/tasks.js";
import type { PhaseContext } from "../src/phases/base.js";

let tmpDir: string;
let session: SessionManager;
let logger: AuditLogger;
let checkpoint: HumanCheckpoint;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "tasks-phase-test-"));
  session = await SessionManager.create(tmpDir);
  logger = new AuditLogger(tmpDir, session.get().sessionId);
  checkpoint = new HumanCheckpoint(logger, session.get().sessionId, "proceed");
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

function makeContext(registry: AgentRegistry): PhaseContext {
  return {
    session,
    logger,
    checkpoint,
    registry,
    consensus: {
      run: async () => ({
        outcome: "consensus-reached",
        rounds: 1,
        summary: "ok",
      }),
    } as PhaseContext["consensus"],
  };
}

describe("runTasksPhase", () => {
  it("rejects task assignment when no reviewer distinct from the primary agent exists", async () => {
    const tasksPath = join(tmpDir, "tasks.md");
    await writeFile(tasksPath, "- [ ] 1.1 Do the thing\n", "utf8");

    const registry = new AgentRegistry({
      solo: {
        cli: "codex",
        canReview: true,
        canRevise: true,
        canImplement: true,
        allowSubInvocation: false,
      },
    });

    await expect(runTasksPhase(makeContext(registry), tasksPath)).rejects.toThrow(/distinct from primary agent/);
  });
});
