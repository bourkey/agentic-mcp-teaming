import { readFile } from "fs/promises";
import { PhaseContext, runArtifactConsensus, transitionPhase } from "./base.js";
import { TaskAssignment } from "../schema.js";

function parseTaskAssignments(content: string, implementers: string[], reviewers: string[]): TaskAssignment[] {
  const lines = content.split("\n");
  const tasks: TaskAssignment[] = [];
  let taskIndex = 0;

  for (const line of lines) {
    const match = line.match(/^-\s*\[[ x]\]\s*(\d+\.\d+)\s+(.+)$/);
    if (match) {
      const primaryAgent = implementers[taskIndex % implementers.length]!;
      let reviewingAgent: string | undefined;
      for (let offset = 0; offset < reviewers.length; offset++) {
        const candidate = reviewers[(taskIndex + offset) % reviewers.length]!;
        if (candidate !== primaryAgent) {
          reviewingAgent = candidate;
          break;
        }
      }
      if (!reviewingAgent) {
        throw new Error(
          `Task assignment requires a reviewer distinct from primary agent "${primaryAgent}", but none is available.`
        );
      }
      tasks.push({
        taskId: match[1]!,
        description: match[2]!,
        primaryAgent,
        reviewingAgent,
      });
      taskIndex++;
    }
  }
  return tasks;
}

export async function runTasksPhase(
  ctx: PhaseContext,
  tasksPath: string
): Promise<TaskAssignment[]> {
  const content = await readFile(tasksPath, "utf8");
  const outcome = await runArtifactConsensus(ctx, "tasks", content);
  ctx.logger.log({ type: "phase_complete", phase: "task", outcome, sessionId: ctx.session.get().sessionId });
  if (outcome === "aborted") throw new Error("Tasks phase aborted.");

  const implementers = ctx.registry.implementers();
  const reviewers = ctx.registry.reviewers();
  const assignments = parseTaskAssignments(content, implementers, reviewers);

  // Present assignment for consensus
  const assignmentDoc = assignments
    .map((a) => `- ${a.taskId}: primary=${a.primaryAgent}, reviewer=${a.reviewingAgent} — ${a.description}`)
    .join("\n");

  const assignmentOutcome = await runArtifactConsensus(
    ctx,
    "task-assignment",
    `## Task Assignment\n\n${assignmentDoc}`
  );
  if (assignmentOutcome === "aborted") throw new Error("Task assignment aborted.");

  await ctx.session.update({ taskAssignments: assignments });
  ctx.logger.log({
    type: "task_assignments_set",
    count: assignments.length,
    sessionId: ctx.session.get().sessionId,
  });

  await transitionPhase(ctx, "task-assignment");
  return assignments;
}
