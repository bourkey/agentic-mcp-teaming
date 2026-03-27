import { readFile } from "fs/promises";
import { PhaseContext, runArtifactConsensus, transitionPhase } from "./base.js";

export async function runDesignPhase(
  ctx: PhaseContext,
  designPath: string
): Promise<void> {
  const content = await readFile(designPath, "utf8");
  const outcome = await runArtifactConsensus(ctx, "design", content);
  ctx.logger.log({ type: "phase_complete", phase: "design", outcome, sessionId: ctx.session.get().sessionId });
  if (outcome === "aborted") throw new Error("Design phase aborted.");
  await transitionPhase(ctx, "design");
}
