import { execFile } from "child_process";
import { promisify } from "util";
import { randomUUID } from "crypto";
import { AgentMessage, WorkflowPhase, InvocationContext } from "../../schema.js";
import { AuditLogger } from "../../core/audit.js";
import { AgentRegistry } from "../../core/registry.js";
import { SpawnTracker } from "../../core/spawn-tracker.js";
import { HumanCheckpoint } from "../../core/checkpoint.js";

const execFileAsync = promisify(execFile);

export interface AgentToolsContext {
  registry: AgentRegistry;
  spawnTracker: SpawnTracker;
  timeoutMs: number;
  logger: AuditLogger;
  sessionId: string;
  phase: WorkflowPhase;
  checkpoint: HumanCheckpoint;
  coordinatorUrl?: string;
  coordinatorAuthToken?: string;
  persistSpawnStats?: (stats: { activeCount: number; sessionTotal: number }) => Promise<void>;
}

export type AgentInvokeFn = (ctx: AgentToolsContext, params: AgentInvokeParams) => Promise<AgentMessage>;

export interface AgentInvokeParams {
  agentId: string;
  prompt: string;
  artifactId: string;
  round: number;
  context?: string;
  snapshotContext?: Record<string, string>;
  invocationContext?: InvocationContext;
}

function parseAgentMessage(
  raw: string,
  agentId: string,
  artifactId: string,
  round: number,
  phase: WorkflowPhase
): AgentMessage {
  let parsed: unknown;
  try {
    const jsonMatch = raw.match(/```json\s*([\s\S]*?)\s*```/) ?? raw.match(/(\{[\s\S]*\})/);
    parsed = JSON.parse(jsonMatch ? jsonMatch[1]! : raw);
  } catch {
    return {
      version: "1",
      role: agentId,
      phase,
      action: "comment",
      content: raw,
      artifactId,
      round,
    };
  }
  const result = AgentMessage.safeParse(parsed);
  if (result.success) return result.data;
  return {
    version: "1",
    role: agentId,
    phase,
    action: "comment",
    content: raw,
    artifactId,
    round,
  };
}

const AGENT_SYSTEM_PROMPT = `You are participating in a structured artifact review workflow.
Respond ONLY with a JSON object matching this schema:
{
  "version": "1",
  "role": "<your-role>",
  "phase": "<current-phase>",
  "action": "approve" | "request-changes" | "block" | "comment" | "implement" | "submit",
  "content": "<your detailed feedback or implementation>",
  "artifactId": "<artifact-id>",
  "round": <round-number>
}

Use "approve" when you accept the artifact as-is.
Use "request-changes" when you have specific, actionable improvement requests.
Use "block" only for fundamental objections that cannot be resolved through revision.
Include your reasoning in "content".`;

export async function invokeAgentTool(
  ctx: AgentToolsContext,
  params: AgentInvokeParams
): Promise<AgentMessage> {
  const invocationContext: InvocationContext = params.invocationContext ?? {
    invocationId: randomUUID(),
    parentInvocationId: null,
    depth: 1,
  };

  const source: "coordinator" | "agent" = invocationContext.depth === 1 ? "coordinator" : "agent";

  // Guardrail check
  const check = ctx.spawnTracker.check(invocationContext, params.agentId, ctx.registry, source);
  if (!check.allowed) {
    ctx.logger.log({
      type: "spawn_rejected",
      agentId: params.agentId,
      parentInvocationId: invocationContext.parentInvocationId,
      depth: invocationContext.depth,
      reason: check.reason,
      sessionId: ctx.sessionId,
      ...ctx.spawnTracker.getStats(),
    });

    if (check.shouldEscalate) {
      await ctx.checkpoint.prompt(
        params.artifactId,
        `Spawn rejected: ${check.reason} (agentId=${params.agentId}, depth=${invocationContext.depth})`,
        []
      );
    }

    await ctx.persistSpawnStats?.(ctx.spawnTracker.getStats());
    throw new Error(`invoke_agent rejected: ${check.reason}`);
  }

  const agent = ctx.registry.get(params.agentId)!;
  const atWarning = ctx.spawnTracker.beginInvocation(
    invocationContext,
    source,
    params.agentId,
    agent.allowSubInvocation
  );
  await ctx.persistSpawnStats?.(ctx.spawnTracker.getStats());
  if (atWarning) {
    ctx.logger.log({
      type: "spawn_budget_warning",
      sessionId: ctx.sessionId,
      ...ctx.spawnTracker.getStats(),
      maxSessionInvocations: ctx.spawnTracker.getStats().sessionTotal,
    });
  }

  const specialtyLine = agent.specialty
    ? `\nYour specialty: ${agent.specialty}`
    : "";
  const systemPrompt = AGENT_SYSTEM_PROMPT + specialtyLine;

  const contextBlocks = Object.entries(params.snapshotContext ?? {})
    .map(([k, v]) => `### Tool: ${k}\n\`\`\`\n${v}\n\`\`\``)
    .join("\n\n");

  const userContent = [
    contextBlocks ? `## Shared Context\n\n${contextBlocks}` : "",
    params.context ?? "",
    params.prompt,
  ]
    .filter(Boolean)
    .join("\n\n---\n\n");

  // Inject sub-invocation transport hint for delegation-eligible agents
  const subInvocationHint = agent.allowSubInvocation
    ? `\n\nYou may invoke other agents via the coordinator MCP tool \`invoke_agent\`. ` +
      `Use COORDINATOR_MCP_URL for the coordinator endpoint and COORDINATOR_MCP_AUTH_TOKEN if auth is required. ` +
      `Pass invocationContext: { invocationId: <new-uuid>, parentInvocationId: "${invocationContext.invocationId}", depth: ${invocationContext.depth + 1} }`
    : "";

  const fullPrompt = `${systemPrompt}${subInvocationHint}\n\n---\n\n${userContent}`;

  let stdout: string;
  const childEnv = agent.allowSubInvocation
    ? {
        ...process.env,
        ...(ctx.coordinatorUrl ? { COORDINATOR_MCP_URL: ctx.coordinatorUrl } : {}),
        ...(ctx.coordinatorAuthToken ? { COORDINATOR_MCP_AUTH_TOKEN: ctx.coordinatorAuthToken } : {}),
        COORDINATOR_PARENT_INVOCATION_ID: invocationContext.invocationId,
        COORDINATOR_PARENT_DEPTH: String(invocationContext.depth),
        COORDINATOR_AGENT_ID: params.agentId,
      }
    : process.env;
  try {
    // Claude CLI uses -p flag; codex CLI takes prompt directly
    const args = agent.cli === "claude" ? ["-p", fullPrompt] : [fullPrompt];
    ({ stdout } = await execFileAsync(agent.cli, args, { timeout: ctx.timeoutMs, env: childEnv }));
  } finally {
    ctx.spawnTracker.endInvocation(invocationContext, source);
    await ctx.persistSpawnStats?.(ctx.spawnTracker.getStats());
  }

  const msg = parseAgentMessage(stdout, params.agentId, params.artifactId, params.round, ctx.phase);

  ctx.logger.log({
    type: "agent_invocation",
    tool: "invoke_agent",
    agentId: params.agentId,
    invocationId: invocationContext.invocationId,
    parentInvocationId: invocationContext.parentInvocationId,
    depth: invocationContext.depth,
    sessionId: ctx.sessionId,
    phase: ctx.phase,
    artifactId: params.artifactId,
    round: params.round,
    response: { action: msg.action, content: msg.content },
  });

  return msg;
}

export function makeMockAgentTool(agentId: string, action: AgentMessage["action"] = "approve") {
  return async (_ctx: AgentToolsContext, params: AgentInvokeParams): Promise<AgentMessage> => ({
    version: "1",
    role: agentId,
    phase: "proposal",
    action,
    content: `[mock ${agentId}] ${action}: ${params.prompt.slice(0, 80)}`,
    artifactId: params.artifactId,
    round: params.round,
  });
}
