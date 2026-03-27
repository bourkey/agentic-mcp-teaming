import { SessionManager } from "../../core/session.js";
import { AuditLogger } from "../../core/audit.js";
import { ConsensusLoop } from "../../core/consensus.js";
import { WorkflowPhase, ArtifactOutcome, SessionState } from "../../schema.js";

export interface WorkflowToolsContext {
  session: SessionManager;
  logger: AuditLogger;
  consensus: ConsensusLoop;
}

const PHASE_ORDER: WorkflowPhase[] = [
  "proposal",
  "design",
  "spec",
  "task",
  "implementation",
  "review",
];

export async function submitForConsensusTool(
  ctx: WorkflowToolsContext,
  params: { artifactId: string; content: string }
): Promise<{ outcome: ArtifactOutcome; summary: string }> {
  const state = ctx.session.get();
  ctx.logger.log({
    type: "consensus_start",
    artifactId: params.artifactId,
    phase: state.currentPhase,
    sessionId: state.sessionId,
  });
  const result = await ctx.consensus.run(params.artifactId, params.content);
  await ctx.session.setArtifactOutcome(params.artifactId, result.outcome);
  ctx.logger.log({
    type: "consensus_end",
    artifactId: params.artifactId,
    outcome: result.outcome,
    rounds: result.rounds,
    sessionId: state.sessionId,
  });
  return result;
}

export async function advancePhaseTool(
  ctx: WorkflowToolsContext,
  params: { artifactId: string }
): Promise<{ newPhase: WorkflowPhase }> {
  const state = ctx.session.get();
  const outcome = state.artifactOutcomes[params.artifactId];
  if (outcome !== "consensus-reached" && outcome !== "human-approved") {
    throw new Error(
      `Cannot advance phase: artifact '${params.artifactId}' outcome is '${outcome ?? "pending"}', need consensus-reached or human-approved`
    );
  }
  const currentIndex = PHASE_ORDER.indexOf(state.currentPhase);
  const nextPhase = PHASE_ORDER[currentIndex + 1];
  if (!nextPhase) {
    throw new Error(`Already at final phase: ${state.currentPhase}`);
  }
  await ctx.session.setPhase(nextPhase);
  ctx.logger.log({
    type: "phase_advance",
    fromPhase: state.currentPhase,
    toPhase: nextPhase,
    triggeredBy: params.artifactId,
    sessionId: state.sessionId,
  });
  return { newPhase: nextPhase };
}

export function getSessionStateTool(ctx: WorkflowToolsContext): SessionState {
  return ctx.session.get();
}

export async function resolveCheckpointTool(
  ctx: WorkflowToolsContext,
  params: { decision: "proceed" | "abort"; artifactId?: string; reason?: string }
): Promise<{ resolved: boolean; outcome: ArtifactOutcome | "aborted" }> {
  const state = ctx.session.get();
  const outcome: ArtifactOutcome = params.decision === "proceed" ? "human-approved" : "aborted";

  if (params.artifactId) {
    await ctx.session.setArtifactOutcome(params.artifactId, outcome);
  }
  await ctx.session.update({ checkpointPending: false });

  ctx.logger.log({
    type: "checkpoint_resolved",
    decision: params.decision,
    artifactId: params.artifactId,
    outcome,
    reason: params.reason,
    sessionId: state.sessionId,
  });

  if (params.decision === "abort") {
    throw new Error(`Workflow aborted by human operator. Reason: ${params.reason ?? "none"}`);
  }

  return { resolved: true, outcome };
}
