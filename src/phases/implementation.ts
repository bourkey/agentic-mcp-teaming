import { execFile } from "child_process";
import { mkdtemp, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { promisify } from "util";
import { PhaseContext } from "./base.js";
import { TaskAssignment, SessionState } from "../schema.js";
import { AgentToolsContext, invokeAgentTool, type AgentInvokeFn } from "../server/tools/agents.js";

const execFileAsync = promisify(execFile);

type TaskWorktreeStatus = SessionState["taskWorktrees"][string]["status"];

interface GitContext {
  repoRoot: string;
  sessionBranch: string;
}

interface ImplementationPhaseOptions {
  invokeAgent?: AgentInvokeFn;
}

interface GeneratedPatch {
  summary: string;
  commitMessage: string;
  patch: string;
}

type ReviewOutcome =
  | { status: "approved" }
  | { status: "needs-revision"; feedback: string }
  | { status: "human-approved" };

type IntegrationOutcome =
  | { status: "integrated" }
  | { status: "replay-required" };

async function git(args: string[], cwd: string): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd });
  return stdout.trim();
}

async function getCurrentCommit(cwd: string): Promise<string> {
  return git(["rev-parse", "HEAD"], cwd);
}

async function createWorktree(
  repoRoot: string,
  taskId: string,
  baseCommit: string
): Promise<{ branch: string; worktreePath: string }> {
  const branch = `task/${taskId.replace(/\./g, "-")}`;
  const worktreePath = join(repoRoot, ".worktrees", branch.replace("/", "-"));
  await git(["branch", branch, baseCommit], repoRoot);
  await git(["worktree", "add", worktreePath, branch], repoRoot);
  return { branch, worktreePath };
}

async function removeWorktree(repoRoot: string, worktreePath: string, branch: string): Promise<void> {
  try {
    await git(["worktree", "remove", "--force", worktreePath], repoRoot);
    await git(["branch", "-D", branch], repoRoot);
  } catch {
    // Best-effort cleanup
  }
}

async function getDiff(baseRef: string, worktreePath: string): Promise<string> {
  return git(["diff", `${baseRef}..HEAD`], worktreePath);
}

function stripDiffBlock(content: string): string {
  return content
    .replace(/```diff[\s\S]*?```/gi, "")
    .replace(/diff --git[\s\S]*/i, "")
    .trim();
}

function parseGeneratedPatch(content: string, taskId: string): GeneratedPatch {
  const diffMatch = content.match(/```diff\s*([\s\S]*?)```/i) ?? content.match(/(diff --git[\s\S]*)/);
  const patch = diffMatch?.[1] ?? diffMatch?.[0];
  if (!patch) {
    throw new Error(`Implementation response for task ${taskId} did not include a unified diff patch.`);
  }

  const commitMessageMatch = content.match(/(?:^|\n)Commit message:\s*(.+)/i);
  const commitMessage = commitMessageMatch?.[1]?.trim() || `Implement task ${taskId}`;
  const summary = stripDiffBlock(content) || `Implemented task ${taskId}`;

  return { summary, commitMessage, patch };
}

async function writePatchFile(patch: string): Promise<{ patchPath: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), "task-patch-"));
  const patchPath = join(dir, "change.diff");
  const serializedPatch = patch.endsWith("\n") ? patch : `${patch}\n`;
  await writeFile(patchPath, serializedPatch, "utf8");
  return {
    patchPath,
    cleanup: async () => {
      await rm(dir, { recursive: true, force: true });
    },
  };
}

export class ImplementationPhase {
  private readonly maxReviewRounds = 3;
  private readonly invokeAgentFn: AgentInvokeFn;

  constructor(
    private readonly ctx: PhaseContext,
    private readonly gitCtx: GitContext,
    private readonly agentCtx: AgentToolsContext,
    options: ImplementationPhaseOptions = {}
  ) {
    this.invokeAgentFn = options.invokeAgent ?? invokeAgentTool;
  }

  async run(assignments: TaskAssignment[]): Promise<void> {
    const sessionBranch = this.gitCtx.sessionBranch;
    const repoRoot = this.gitCtx.repoRoot;

    await git(["rev-parse", "--is-inside-work-tree"], repoRoot);

    for (const task of assignments) {
      await this.runTask(task, repoRoot, sessionBranch);
    }

    this.ctx.logger.log({
      type: "implementation_complete",
      taskCount: assignments.length,
      sessionId: this.ctx.session.get().sessionId,
    });
  }

  private async runTask(task: TaskAssignment, repoRoot: string, sessionBranch: string): Promise<void> {
    const baseCommit = await getCurrentCommit(repoRoot);
    const { branch, worktreePath } = await createWorktree(repoRoot, task.taskId, baseCommit);

    await this.ctx.session.update({
      taskWorktrees: {
        ...this.ctx.session.get().taskWorktrees,
        [task.taskId]: { branch, worktreePath, baseCommit, status: "implementing" },
      },
    });

    this.ctx.logger.log({
      type: "task_start",
      taskId: task.taskId,
      primaryAgent: task.primaryAgent,
      branch,
      baseCommit,
      sessionId: this.ctx.session.get().sessionId,
    });

    try {
      let reviewBase = baseCommit;
      let feedbackHistory: string[] = [];
      let generated = await this.generateTaskPatch(task, reviewBase, feedbackHistory, 0);
      await this.materializePatch(worktreePath, reviewBase, generated);
      let diff = await getDiff(reviewBase, worktreePath);

      while (true) {
        await this.updateTaskStatus(task.taskId, "reviewing");

        const reviewOutcome = await this.reviewTaskImplementation(
          task,
          generated.summary,
          diff,
          reviewBase,
          feedbackHistory
        );

        if (reviewOutcome.status === "needs-revision") {
          feedbackHistory = [...feedbackHistory, reviewOutcome.feedback];
          await this.updateTaskStatus(task.taskId, "implementing");
          generated = await this.generateTaskPatch(task, reviewBase, feedbackHistory, feedbackHistory.length);
          await this.materializePatch(worktreePath, reviewBase, generated);
          diff = await getDiff(reviewBase, worktreePath);
          continue;
        }

        const integration = await this.integrateTask(
          repoRoot,
          sessionBranch,
          branch,
          task.taskId,
          worktreePath
        );

        if (integration.status === "integrated") {
          await this.updateTaskStatus(task.taskId, "integrated");
          this.ctx.logger.log({
            type: "task_integrated",
            taskId: task.taskId,
            branch,
            sessionId: this.ctx.session.get().sessionId,
          });
          break;
        }

        reviewBase = sessionBranch;
        diff = await getDiff(reviewBase, worktreePath);
        generated = {
          ...generated,
          summary: `${generated.summary}\n\nReplayed onto the current ${sessionBranch} head and requires re-review before merge.`,
        };
        feedbackHistory = [];
      }
    } catch (err) {
      await this.updateTaskStatus(task.taskId, "failed");
      throw err;
    } finally {
      await removeWorktree(repoRoot, worktreePath, branch);
    }
  }

  private async generateTaskPatch(
    task: TaskAssignment,
    baseRef: string,
    feedbackHistory: string[],
    round: number
  ): Promise<GeneratedPatch> {
    const feedbackBlock = feedbackHistory.length === 0
      ? ""
      : `\n\n## Reviewer Feedback To Address\n${feedbackHistory.map((entry, index) => `${index + 1}. ${entry}`).join("\n")}`;

    const prompt = `Implement task ${task.taskId}.

## Task
${task.description}

## Requirements
- Produce a complete unified diff patch against ${baseRef}.
- Do not describe filesystem edits as intentions; return the actual patch.
- Include a single-line "Commit message: ..." before the patch.
- Wrap the patch in a \`\`\`diff fenced block.
- The patch must be self-contained and incorporate all prior feedback.${feedbackBlock}

Return action "implement" and place the commit message plus diff patch in the "content" field.`;

    const response = await this.invokeAgentFn(
      { ...this.agentCtx, phase: "implementation" },
      { agentId: task.primaryAgent, prompt, artifactId: task.taskId, round }
    );

    this.ctx.logger.log({
      type: "task_patch_generated",
      taskId: task.taskId,
      round,
      agent: task.primaryAgent,
      sessionId: this.ctx.session.get().sessionId,
    });

    return parseGeneratedPatch(response.content, task.taskId);
  }

  private async materializePatch(
    worktreePath: string,
    baseRef: string,
    generated: GeneratedPatch
  ): Promise<void> {
    await git(["reset", "--hard", baseRef], worktreePath);
    await git(["clean", "-fd"], worktreePath);

    const { patchPath, cleanup } = await writePatchFile(generated.patch);
    try {
      await git(["apply", "--check", "--index", patchPath], worktreePath);
      await git(["apply", "--index", patchPath], worktreePath);
    } finally {
      await cleanup();
    }

    const status = await git(["status", "--porcelain"], worktreePath);
    if (!status.trim()) {
      throw new Error("Generated patch did not change any files.");
    }

    await git(["commit", "-m", generated.commitMessage], worktreePath);
  }

  private async reviewTaskImplementation(
    task: TaskAssignment,
    summary: string,
    diff: string,
    baseRef: string,
    feedbackHistory: string[]
  ): Promise<ReviewOutcome> {
    for (let reviewRound = 0; reviewRound < this.maxReviewRounds; reviewRound++) {
      const priorFeedback = feedbackHistory.length === 0
        ? ""
        : `\n\n## Prior Review Feedback\n${feedbackHistory.map((entry, index) => `${index + 1}. ${entry}`).join("\n")}`;

      const reviewPrompt = `Review the following implementation for task ${task.taskId}.

## Implementation Summary
${summary}

## Diff Against ${baseRef}
\`\`\`diff
${diff.slice(0, 12000)}
\`\`\`${priorFeedback}

Approve if the implementation correctly addresses the task, request-changes with specific feedback if it needs revision, or block only for a fundamental objection.`;

      const reviewMsg = await this.invokeAgentFn(
        { ...this.agentCtx, phase: "review" },
        { agentId: task.reviewingAgent, prompt: reviewPrompt, artifactId: task.taskId, round: reviewRound }
      );

      if (reviewMsg.action === "approve") {
        return { status: "approved" };
      }

      if (reviewMsg.action === "request-changes") {
        return { status: "needs-revision", feedback: reviewMsg.content };
      }

      if (reviewMsg.action === "block") {
        this.ctx.logger.log({
          type: "task_blocked",
          taskId: task.taskId,
          reason: reviewMsg.content,
          sessionId: this.ctx.session.get().sessionId,
        });
        await this.ctx.session.update({ checkpointPending: true });
        const decision = await this.ctx.checkpoint.prompt(task.taskId, `Task blocked: ${reviewMsg.content}`, []);
        await this.ctx.session.update({ checkpointPending: false });
        if (decision === "abort") {
          throw new Error(`Task ${task.taskId} blocked and aborted.`);
        }
        return { status: "human-approved" };
      }
    }

    await this.ctx.session.update({ checkpointPending: true });
    const decision = await this.ctx.checkpoint.prompt(task.taskId, `Review cap reached for task ${task.taskId}`, []);
    await this.ctx.session.update({ checkpointPending: false });
    if (decision === "abort") {
      throw new Error(`Task ${task.taskId} failed after review cap.`);
    }
    return { status: "human-approved" };
  }

  private async integrateTask(
    repoRoot: string,
    sessionBranch: string,
    taskBranch: string,
    taskId: string,
    worktreePath: string
  ): Promise<IntegrationOutcome> {
    try {
      await git(["checkout", sessionBranch], repoRoot);
      await git(["merge", "--no-ff", taskBranch, "-m", `Integrate task ${taskId}`], repoRoot);
      return { status: "integrated" };
    } catch (err) {
      this.ctx.logger.log({
        type: "integration_conflict",
        taskId,
        error: String(err),
        sessionId: this.ctx.session.get().sessionId,
      });
      await git(["merge", "--abort"], repoRoot).catch(() => undefined);
      await this.ctx.session.update({ checkpointPending: true });
      const decision = await this.ctx.checkpoint.prompt(
        taskId,
        `Integration conflict for task ${taskId}.\nThe task branch will be replayed onto ${sessionBranch} before re-review.`,
        []
      );
      await this.ctx.session.update({ checkpointPending: false });
      if (decision === "abort") {
        throw new Error(`Integration of task ${taskId} aborted by human.`);
      }

      try {
        await git(["rebase", sessionBranch], worktreePath);
      } catch (rebaseErr) {
        await git(["rebase", "--abort"], worktreePath).catch(() => undefined);
        throw new Error(`Failed to replay task ${taskId} onto ${sessionBranch}: ${String(rebaseErr)}`);
      }

      this.ctx.logger.log({
        type: "task_replayed_for_rereview",
        taskId,
        sessionBranch,
        sessionId: this.ctx.session.get().sessionId,
      });

      return { status: "replay-required" };
    }
  }

  private async updateTaskStatus(taskId: string, status: TaskWorktreeStatus): Promise<void> {
    const existing = this.ctx.session.get().taskWorktrees[taskId];
    if (!existing) return;
    await this.ctx.session.update({
      taskWorktrees: {
        ...this.ctx.session.get().taskWorktrees,
        [taskId]: { ...existing, status },
      },
    });
  }
}
