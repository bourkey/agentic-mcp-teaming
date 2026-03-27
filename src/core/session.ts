import { readFile, writeFile, mkdir } from "fs/promises";
import { join } from "path";
import { randomUUID } from "crypto";
import { SessionState, WorkflowPhase } from "../schema.js";

export class SessionManager {
  private state: SessionState;
  private readonly statePath: string;

  private constructor(state: SessionState, statePath: string) {
    this.state = state;
    this.statePath = statePath;
  }

  static async create(sessionsDir: string, sessionId?: string): Promise<SessionManager> {
    const id = sessionId ?? randomUUID();
    const dir = join(sessionsDir, id);
    const statePath = join(dir, "state.json");
    await mkdir(dir, { recursive: true });

    const now = new Date().toISOString();
    const initial: SessionState = {
      sessionId: id,
      currentPhase: "proposal",
      artifactOutcomes: {},
      snapshotIds: {},
      revisionRounds: {},
      taskAssignments: [],
      taskWorktrees: {},
      spawnStats: { activeCount: 0, sessionTotal: 0 },
      checkpointPending: false,
      startedAt: now,
      updatedAt: now,
    };
    await writeFile(statePath, JSON.stringify(initial, null, 2), "utf8");
    return new SessionManager(initial, statePath);
  }

  static async load(sessionsDir: string, sessionId: string): Promise<SessionManager> {
    const statePath = join(sessionsDir, sessionId, "state.json");
    const raw = await readFile(statePath, "utf8");
    const state = SessionState.parse(JSON.parse(raw) as unknown);
    return new SessionManager(state, statePath);
  }

  get(): SessionState {
    return this.state;
  }

  async update(patch: Partial<SessionState>): Promise<void> {
    this.state = SessionState.parse({
      ...this.state,
      ...patch,
      updatedAt: new Date().toISOString(),
    });
    await writeFile(this.statePath, JSON.stringify(this.state, null, 2), "utf8");
  }

  async setPhase(phase: WorkflowPhase): Promise<void> {
    await this.update({ currentPhase: phase });
  }

  async setArtifactOutcome(
    artifactId: string,
    outcome: SessionState["artifactOutcomes"][string]
  ): Promise<void> {
    await this.update({
      artifactOutcomes: { ...this.state.artifactOutcomes, [artifactId]: outcome },
    });
  }

  async incrementRevisionRound(artifactId: string): Promise<number> {
    const current = this.state.revisionRounds[artifactId] ?? 0;
    const next = current + 1;
    await this.update({
      revisionRounds: { ...this.state.revisionRounds, [artifactId]: next },
    });
    return next;
  }
}
