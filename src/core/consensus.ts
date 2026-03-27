import { AgentMessage, ArtifactOutcome } from "../schema.js";
import { AuditLogger } from "./audit.js";
import { SessionManager } from "./session.js";
import { SnapshotStore } from "./snapshot.js";
import { HumanCheckpoint } from "./checkpoint.js";
import { AgentToolsContext, invokeAgentTool, type AgentInvokeParams } from "../server/tools/agents.js";

export type AgentInvokeFn = (
  ctx: AgentToolsContext,
  params: AgentInvokeParams
) => Promise<AgentMessage>;

export type EvaluationResult = "consensus-reached" | "needs-revision" | "block";

export function evaluateConsensus(msgs: AgentMessage[]): EvaluationResult {
  if (msgs.some((m) => m.action === "block")) return "block";
  if (msgs.every((m) => m.action === "approve")) return "consensus-reached";
  return "needs-revision";
}

export function aggregateFeedback(msgs: AgentMessage[], round: number, perAgentLimit = 2048): string {
  const sections = msgs
    .filter((m) => m.action === "request-changes")
    .map((m) => {
      const content =
        m.content.length > perAgentLimit
          ? m.content.slice(0, perAgentLimit) + "[truncated]"
          : m.content;
      return `### From: ${m.role}\n${content}`;
    })
    .join("\n\n");

  return `## Revision Requested — Round ${round}\n\n${sections}`;
}

export interface ConsensusResult {
  outcome: ArtifactOutcome;
  rounds: number;
  summary: string;
}

export interface ConsensusLoopOptions {
  maxRounds?: number;
  reviewerAgentIds?: string[];
  reviserAgentId?: string;
  invokeAgent?: AgentInvokeFn;
}

export class ConsensusLoop {
  private readonly maxRounds: number;
  private readonly reviewerAgentIds: string[];
  private readonly reviserAgentId: string;
  private readonly invokeAgent: AgentInvokeFn;

  constructor(
    private readonly agentCtx: AgentToolsContext,
    private readonly session: SessionManager,
    private readonly logger: AuditLogger,
    private readonly snapshots: SnapshotStore,
    private readonly checkpoint: HumanCheckpoint,
    options: ConsensusLoopOptions = {}
  ) {
    this.maxRounds = options.maxRounds ?? 3;
    this.invokeAgent = options.invokeAgent ?? invokeAgentTool;

    // Default reviewer/reviser lists from registry if not explicitly provided
    const registryReviewers = agentCtx.registry.reviewers();
    const registryRevisers = agentCtx.registry.revisers();

    this.reviewerAgentIds = options.reviewerAgentIds ?? registryReviewers;
    this.reviserAgentId = options.reviserAgentId ?? registryRevisers[0] ?? registryReviewers[0]!;

    if (this.reviewerAgentIds.length === 0) {
      throw new Error("ConsensusLoop: no reviewer agents configured.");
    }
  }

  async run(artifactId: string, content: string): Promise<ConsensusResult> {
    let currentContent = content;
    let round = 0;
    const history: Array<{ round: number; msgs: AgentMessage[] }> = [];

    while (round < this.maxRounds) {
      const snapshot = await this.snapshots.capture(artifactId, currentContent, round);

      this.logger.log({
        type: "review_round_start",
        artifactId,
        round,
        snapshotId: snapshot.snapshotId,
        reviewerAgentIds: this.reviewerAgentIds,
        sessionId: this.session.get().sessionId,
      });

      // Parallel first-pass: all reviewers see the same snapshot concurrently
      const msgs = await Promise.all(
        this.reviewerAgentIds.map(async (agentId) => {
          try {
            return await this.invokeAgent(this.agentCtx, {
              agentId,
              prompt: this.buildReviewPrompt(artifactId, currentContent, history),
              artifactId,
              round,
              snapshotContext: snapshot.toolOutputs,
            });
          } catch {
            // CLI error/timeout → treated as block from that agent
            this.logger.log({
              type: "agent_error",
              agentId,
              artifactId,
              round,
              sessionId: this.session.get().sessionId,
            });
            const blockMsg: AgentMessage = {
              version: "1",
              role: agentId,
              phase: this.agentCtx.phase,
              action: "block",
              content: `Agent ${agentId} failed to respond (CLI error or timeout).`,
              artifactId,
              round,
            };
            return blockMsg;
          }
        })
      );

      history.push({ round, msgs });

      this.logger.log({
        type: "review_round_responses",
        artifactId,
        round,
        agentActions: Object.fromEntries(msgs.map((m) => [m.role, m.action])),
        sessionId: this.session.get().sessionId,
      });

      const evaluation = evaluateConsensus(msgs);

      if (evaluation === "block") {
        const blockers = msgs.filter((m) => m.action === "block");
        this.logger.log({
          type: "block_escalation",
          artifactId,
          blockers: blockers.map((b) => ({ agent: b.role, reason: b.content })),
          sessionId: this.session.get().sessionId,
        });
        const decision = await this.checkpoint.prompt(
          artifactId,
          `BLOCKED:\n${blockers.map((b) => `${b.role}: ${b.content}`).join("\n\n")}`,
          history.flatMap((h) => h.msgs)
        );
        if (decision === "abort") {
          return { outcome: "aborted", rounds: round + 1, summary: "Aborted by human after block." };
        }
        return { outcome: "human-approved", rounds: round + 1, summary: `Human approved after block.` };
      }

      if (evaluation === "consensus-reached") {
        return {
          outcome: "consensus-reached",
          rounds: round + 1,
          summary: `Consensus reached in ${round + 1} round(s).`,
        };
      }

      // needs-revision — aggregate feedback and route to reviser
      round++;
      if (round >= this.maxRounds) break;

      const aggregated = aggregateFeedback(msgs, round);
      currentContent = await this.requestRevision(artifactId, currentContent, aggregated, round);
      await this.session.incrementRevisionRound(artifactId);
    }

    // Cap reached
    this.logger.log({
      type: "revision_cap_reached",
      artifactId,
      rounds: this.maxRounds,
      sessionId: this.session.get().sessionId,
    });
    const lastHistory = history[history.length - 1];
    const summary = lastHistory
      ? aggregateFeedback(lastHistory.msgs, lastHistory.round)
      : `No rounds completed for ${artifactId}.`;

    const decision = await this.checkpoint.prompt(
      artifactId,
      `Revision cap (${this.maxRounds}) reached.\n\n${summary}`,
      history.flatMap((h) => h.msgs)
    );
    if (decision === "abort") {
      return { outcome: "aborted", rounds: this.maxRounds, summary: "Aborted by human after revision cap." };
    }
    return { outcome: "human-approved", rounds: this.maxRounds, summary: `Human approved after ${this.maxRounds} revision rounds.` };
  }

  private buildReviewPrompt(
    artifactId: string,
    content: string,
    history: Array<{ round: number; msgs: AgentMessage[] }>
  ): string {
    const historyText =
      history.length === 0
        ? ""
        : "\n\n## Prior Round History\n" +
          history
            .map(
              (h) =>
                `### Round ${h.round}\n` +
                h.msgs
                  .map((m) => `**${m.role}**: ${m.action} — ${m.content}`)
                  .join("\n")
            )
            .join("\n\n");

    return `## Artifact: ${artifactId}

${content}
${historyText}

---
Review this artifact. Respond with approve, request-changes (with specific feedback), or block (with reason).`;
  }

  private async requestRevision(
    artifactId: string,
    currentContent: string,
    aggregatedFeedback: string,
    round: number
  ): Promise<string> {
    const revisionPrompt = `## Revision Request — ${artifactId} (Round ${round})

## Current Content
${currentContent}

## Reviewer Feedback
${aggregatedFeedback}

---
Please revise the artifact to address all feedback. Return the full revised content in your response's "content" field with action "submit".`;

    const revisionMsg = await this.invokeAgent(this.agentCtx, {
      agentId: this.reviserAgentId,
      prompt: revisionPrompt,
      artifactId,
      round,
      context: aggregatedFeedback,
    });

    this.logger.log({
      type: "revision_submitted",
      artifactId,
      round,
      reviserAgent: this.reviserAgentId,
      contentLength: revisionMsg.content.length,
      sessionId: this.session.get().sessionId,
    });

    return revisionMsg.content;
  }
}
