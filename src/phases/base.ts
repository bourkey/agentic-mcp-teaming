import { SessionManager } from "../core/session.js";
import { AuditLogger } from "../core/audit.js";
import { ConsensusLoop } from "../core/consensus.js";
import { HumanCheckpoint } from "../core/checkpoint.js";
import { AgentRegistry } from "../core/registry.js";
import { submitForConsensusTool, advancePhaseTool, type WorkflowToolsContext } from "../server/tools/workflow.js";
import { ArtifactOutcome } from "../schema.js";

export interface PhaseContext {
  session: SessionManager;
  logger: AuditLogger;
  consensus: ConsensusLoop;
  checkpoint: HumanCheckpoint;
  registry: AgentRegistry;
}

export async function runArtifactConsensus(
  ctx: PhaseContext,
  artifactId: string,
  content: string
): Promise<ArtifactOutcome> {
  const wfCtx: WorkflowToolsContext = {
    session: ctx.session,
    logger: ctx.logger,
    consensus: ctx.consensus,
  };
  const result = await submitForConsensusTool(wfCtx, { artifactId, content });
  return result.outcome;
}

export async function transitionPhase(
  ctx: PhaseContext,
  artifactId: string
): Promise<void> {
  const state = ctx.session.get();
  const decision = await ctx.checkpoint.promptPhaseTransition(
    state.currentPhase,
    "next",
    state.artifactOutcomes
  );
  if (decision === "abort") {
    throw new Error(`Phase transition aborted by human at ${state.currentPhase}`);
  }
  const wfCtx: WorkflowToolsContext = {
    session: ctx.session,
    logger: ctx.logger,
    consensus: ctx.consensus,
  };
  await advancePhaseTool(wfCtx, { artifactId });
}
