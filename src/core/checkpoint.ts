import { createInterface } from "readline";
import { AgentMessage } from "../schema.js";
import { AuditLogger } from "./audit.js";

export type CheckpointDecision = "proceed" | "abort";

export class HumanCheckpoint {
  constructor(
    private readonly logger: AuditLogger,
    private readonly sessionId: string,
    private readonly autoDecide?: CheckpointDecision
  ) {}

  async prompt(
    artifactId: string,
    reason: string,
    history: AgentMessage[]
  ): Promise<CheckpointDecision> {
    this.displaySummary(artifactId, reason, history);

    if (this.autoDecide !== undefined) {
      console.log(`[Auto-checkpoint] Decision: ${this.autoDecide}`);
      this.logger.log({
        type: "checkpoint_presented",
        artifactId,
        reason: reason.slice(0, 500),
        autoDecide: this.autoDecide,
        sessionId: this.sessionId,
      });
      return this.autoDecide;
    }

    const decision = await this.readDecision();
    this.logger.log({
      type: "checkpoint_presented",
      artifactId,
      reason: reason.slice(0, 500),
      decision,
      sessionId: this.sessionId,
    });
    return decision;
  }

  async promptPhaseTransition(
    fromPhase: string,
    toPhase: string,
    outcomes: Record<string, string>
  ): Promise<CheckpointDecision> {
    console.log("\n" + "=".repeat(60));
    console.log(`PHASE TRANSITION: ${fromPhase} → ${toPhase}`);
    console.log("=".repeat(60));
    console.log("\nArtifact outcomes:");
    for (const [id, outcome] of Object.entries(outcomes)) {
      console.log(`  ${id}: ${outcome}`);
    }
    console.log("");

    if (this.autoDecide !== undefined) {
      console.log(`[Auto-checkpoint] Decision: ${this.autoDecide}`);
      return this.autoDecide;
    }

    const decision = await this.readDecision();
    this.logger.log({
      type: "phase_transition_checkpoint",
      fromPhase,
      toPhase,
      outcomes,
      decision,
      sessionId: this.sessionId,
    });
    return decision;
  }

  private displaySummary(artifactId: string, reason: string, history: AgentMessage[]): void {
    console.log("\n" + "=".repeat(60));
    console.log(`HUMAN CHECKPOINT — ${artifactId}`);
    console.log("=".repeat(60));
    console.log(`\nReason:\n${reason}`);
    if (history.length > 0) {
      console.log("\nReview history:");
      for (const m of history) {
        console.log(`  Round ${m.round} [${m.role}]: ${m.action}`);
      }
    }
    console.log("");
  }

  private readDecision(): Promise<CheckpointDecision> {
    return new Promise((resolve) => {
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      rl.question("Decision [proceed/abort]: ", (answer) => {
        rl.close();
        resolve(answer.trim().toLowerCase() === "abort" ? "abort" : "proceed");
      });
    });
  }
}
