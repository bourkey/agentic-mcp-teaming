import { readFile } from "fs/promises";
import { PhaseContext, runArtifactConsensus, transitionPhase } from "./base.js";

export async function runProposalPhase(
  ctx: PhaseContext,
  proposalPath: string
): Promise<void> {
  const content = await readFile(proposalPath, "utf8");
  const outcome = await runArtifactConsensus(ctx, "proposal", content);
  ctx.logger.log({ type: "phase_complete", phase: "proposal", outcome, sessionId: ctx.session.get().sessionId });
  if (outcome === "aborted") throw new Error("Proposal phase aborted.");
  await transitionPhase(ctx, "proposal");
}
