import { z } from "zod";

export const ConsensusAction = z.enum(["approve", "request-changes", "block"]);
export type ConsensusAction = z.infer<typeof ConsensusAction>;

export const WorkflowPhase = z.enum([
  "proposal",
  "design",
  "spec",
  "task",
  "implementation",
  "review",
]);
export type WorkflowPhase = z.infer<typeof WorkflowPhase>;

// Open string — any registered agentId, or "coordinator" / "human" for system roles
export const AgentRole = z.string();
export type AgentRole = z.infer<typeof AgentRole>;

export const AgentAction = z.enum([
  "submit",
  "approve",
  "request-changes",
  "block",
  "implement",
  "comment",
]);
export type AgentAction = z.infer<typeof AgentAction>;

export const ArtifactOutcome = z.enum([
  "consensus-reached",
  "human-approved",
  "aborted",
  "pending",
]);
export type ArtifactOutcome = z.infer<typeof ArtifactOutcome>;

export const AgentMessage = z.object({
  version: z.literal("1"),
  role: AgentRole,
  phase: WorkflowPhase,
  action: AgentAction,
  content: z.string(),
  artifactId: z.string(),
  round: z.number().int().nonnegative(),
});
export type AgentMessage = z.infer<typeof AgentMessage>;

export const InvocationContext = z.object({
  invocationId: z.string(),
  parentInvocationId: z.string().nullable(),
  depth: z.number().int().nonnegative(),
});
export type InvocationContext = z.infer<typeof InvocationContext>;

export const ReviewSnapshot = z.object({
  snapshotId: z.string(),
  artifactId: z.string(),
  artifactContent: z.string(),
  round: z.number().int().nonnegative(),
  toolOutputs: z.record(z.string(), z.string()),
  capturedAt: z.string(),
});
export type ReviewSnapshot = z.infer<typeof ReviewSnapshot>;

export const TaskAssignment = z.object({
  taskId: z.string(),
  description: z.string(),
  primaryAgent: z.string(),
  reviewingAgent: z.string(),
});
export type TaskAssignment = z.infer<typeof TaskAssignment>;

export const SessionState = z.object({
  sessionId: z.string(),
  currentPhase: WorkflowPhase,
  artifactOutcomes: z.record(z.string(), ArtifactOutcome),
  snapshotIds: z.record(z.string(), z.string()),
  revisionRounds: z.record(z.string(), z.number().int().nonnegative()),
  taskAssignments: z.array(TaskAssignment),
  implBranch: z.string().optional(),
  taskWorktrees: z.record(z.string(), z.object({
    branch: z.string(),
    worktreePath: z.string(),
    baseCommit: z.string(),
    status: z.enum(["pending", "implementing", "reviewing", "approved", "integrated", "failed"]),
  })),
  spawnStats: z.object({
    activeCount: z.number().int().nonnegative(),
    sessionTotal: z.number().int().nonnegative(),
  }).default({ activeCount: 0, sessionTotal: 0 }),
  checkpointPending: z.boolean(),
  startedAt: z.string(),
  updatedAt: z.string(),
});
export type SessionState = z.infer<typeof SessionState>;
