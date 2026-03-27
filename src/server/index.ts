import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import express, { type Request } from "express";
import { z } from "zod";
import { randomUUID } from "crypto";
import { McpConfig } from "../config.js";
import { SharedToolsContext, readFileTool, writeFileTool, grepTool, globTool, bashTool } from "./tools/shared.js";
import { AgentToolsContext, invokeAgentTool, makeMockAgentTool } from "./tools/agents.js";
import { WorkflowToolsContext, submitForConsensusTool, advancePhaseTool, getSessionStateTool, resolveCheckpointTool } from "./tools/workflow.js";
import { AuditLogger } from "../core/audit.js";
import { SessionManager } from "../core/session.js";
import { ConsensusLoop } from "../core/consensus.js";
import { AgentRegistry } from "../core/registry.js";
import { SpawnTracker } from "../core/spawn-tracker.js";
import { HumanCheckpoint } from "../core/checkpoint.js";

export interface CoordinatorServerOptions {
  config: McpConfig;
  session: SessionManager;
  logger: AuditLogger;
  consensus: ConsensusLoop;
  registry: AgentRegistry;
  spawnTracker: SpawnTracker;
  checkpoint: HumanCheckpoint;
  dryRun?: boolean;
}

export function getConfiguredAuthToken(config: McpConfig): string | undefined {
  return config.authTokenEnvVar ? process.env[config.authTokenEnvVar] : undefined;
}

export function extractRequestToken(req: Pick<Request, "header" | "query">): string | undefined {
  const authHeader = req.header("authorization");
  if (authHeader?.startsWith("Bearer ")) {
    return authHeader.slice("Bearer ".length);
  }

  const token = req.query["token"];
  return typeof token === "string" ? token : undefined;
}

export function isAuthorizedRequest(req: Pick<Request, "header" | "query">, expectedToken?: string): boolean {
  if (!expectedToken) return true;
  return extractRequestToken(req) === expectedToken;
}

export function createCoordinatorServer(opts: CoordinatorServerOptions): McpServer {
  const { config, session, logger, consensus, registry, spawnTracker, checkpoint, dryRun = false } = opts;

  const sharedCtx: SharedToolsContext = {
    rootDir: config.rootDir,
    allowlist: new Set(config.toolAllowlist),
  };

  function makeAgentCtx(): AgentToolsContext {
    const state = session.get();
    return {
      registry,
      spawnTracker,
      timeoutMs: 120_000,
      logger,
      sessionId: state.sessionId,
      phase: state.currentPhase,
      checkpoint,
      coordinatorUrl: `http://${config.host}:${config.port}/sse`,
      ...(getConfiguredAuthToken(config) ? { coordinatorAuthToken: getConfiguredAuthToken(config)! } : {}),
      persistSpawnStats: async (stats) => {
        await session.update({ spawnStats: stats });
      },
    };
  }

  const wfCtx: WorkflowToolsContext = { session, logger, consensus };

  const server = new McpServer({
    name: "agentic-mcp-coordinator",
    version: "1.0.0",
  });

  // --- Shared tools ---

  server.tool("read_file", { path: z.string().describe("File path relative to rootDir") }, async ({ path }) => {
    const result = await readFileTool(sharedCtx, { path });
    logger.log({ type: "tool_call", tool: "read_file", params: { path }, resultLength: result.length, sessionId: session.get().sessionId });
    return { content: [{ type: "text", text: result }] };
  });

  server.tool("write_file", { path: z.string(), content: z.string() }, async (params) => {
    const result = await writeFileTool(sharedCtx, params);
    logger.log({ type: "tool_call", tool: "write_file", params: { path: params.path }, sessionId: session.get().sessionId });
    return { content: [{ type: "text", text: result }] };
  });

  server.tool("grep", { pattern: z.string(), path: z.string().optional(), recursive: z.boolean().optional() }, async (params) => {
    const grepParams = {
      pattern: params.pattern,
      ...(params.path !== undefined ? { path: params.path } : {}),
      ...(params.recursive !== undefined ? { recursive: params.recursive } : {}),
    };
    const result = await grepTool(sharedCtx, grepParams);
    logger.log({ type: "tool_call", tool: "grep", params: grepParams, resultLength: result.length, sessionId: session.get().sessionId });
    return { content: [{ type: "text", text: result || "(no matches)" }] };
  });

  server.tool("glob", { pattern: z.string() }, async (params) => {
    const result = await globTool(sharedCtx, params);
    logger.log({ type: "tool_call", tool: "glob", params, sessionId: session.get().sessionId });
    return { content: [{ type: "text", text: result || "(no matches)" }] };
  });

  server.tool("bash", { command: z.string() }, async (params) => {
    const result = await bashTool(sharedCtx, params);
    logger.log({ type: "tool_call", tool: "bash", params: { command: params.command.slice(0, 200) }, sessionId: session.get().sessionId });
    return { content: [{ type: "text", text: result }] };
  });

  // --- Agent trigger tool ---

  const InvocationContextParam = z.object({
    invocationId: z.string(),
    parentInvocationId: z.string().nullable(),
    depth: z.number().int().nonnegative(),
  }).optional();

  server.tool(
    "invoke_agent",
    {
      agentId: z.string().describe("Registered agent ID from the agent registry"),
      prompt: z.string(),
      artifactId: z.string(),
      round: z.number().int().nonnegative(),
      context: z.string().optional(),
      snapshotContext: z.record(z.string(), z.string()).optional(),
      invocationContext: InvocationContextParam,
    },
    async (params) => {
      const agentCtx = makeAgentCtx();
      const mockFn = dryRun ? makeMockAgentTool(params.agentId) : undefined;

      const invocationContext = params.invocationContext ?? {
        invocationId: randomUUID(),
        parentInvocationId: null,
        depth: 1,
      };

      const invokeParams = {
        agentId: params.agentId,
        prompt: params.prompt,
        artifactId: params.artifactId,
        round: params.round,
        invocationContext,
        ...(params.context !== undefined ? { context: params.context } : {}),
        ...(params.snapshotContext !== undefined ? { snapshotContext: params.snapshotContext } : {}),
      };
      const msg = mockFn
        ? await mockFn(agentCtx, invokeParams)
        : await invokeAgentTool(agentCtx, invokeParams);

      return { content: [{ type: "text", text: JSON.stringify(msg) }] };
    }
  );

  // --- Workflow tools ---

  server.tool(
    "submit_for_consensus",
    { artifactId: z.string(), content: z.string() },
    async (params) => {
      const result = await submitForConsensusTool(wfCtx, params);
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    }
  );

  server.tool(
    "advance_phase",
    { artifactId: z.string() },
    async (params) => {
      const result = await advancePhaseTool(wfCtx, params);
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    }
  );

  server.tool("get_session_state", {}, () => {
    const state = getSessionStateTool(wfCtx);
    return { content: [{ type: "text", text: JSON.stringify(state, null, 2) }] };
  });

  server.tool(
    "resolve_checkpoint",
    {
      decision: z.enum(["proceed", "abort"]),
      artifactId: z.string().optional(),
      reason: z.string().optional(),
    },
    async (params) => {
      const resolveParams = {
        decision: params.decision,
        ...(params.artifactId !== undefined ? { artifactId: params.artifactId } : {}),
        ...(params.reason !== undefined ? { reason: params.reason } : {}),
      };
      const result = await resolveCheckpointTool(wfCtx, resolveParams);
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    }
  );

  return server;
}

export async function startHttpServer(
  server: McpServer,
  port: number,
  host = "127.0.0.1",
  authToken?: string
): Promise<() => void> {
  const app = express();
  const transports = new Map<string, SSEServerTransport>();

  app.get("/sse", (req, res) => {
    if (!isAuthorizedRequest(req, authToken)) {
      res.status(401).send("Unauthorized");
      return;
    }
    const transport = new SSEServerTransport("/message", res);
    transports.set(transport.sessionId, transport);
    res.on("close", () => transports.delete(transport.sessionId));
    server.connect(transport).catch(console.error);
  });

  app.post("/message", express.json({ limit: "64kb" }), (req, res) => {
    if (!isAuthorizedRequest(req, authToken)) {
      res.status(401).send("Unauthorized");
      return;
    }
    const sessionId = req.query["sessionId"] as string;
    const transport = transports.get(sessionId);
    if (!transport) { res.status(404).send("Session not found"); return; }
    transport.handlePostMessage(req, res).catch(console.error);
  });

  const httpServer = app.listen(port, host, () => {
    console.log(`Coordinator MCP server listening on http://${host}:${port}/sse`);
  });

  return () => httpServer.close();
}
