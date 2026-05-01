import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import express, { type Request } from "express";
import { z } from "zod";
import { randomUUID, createHash, timingSafeEqual } from "crypto";
import { McpConfig } from "../config.js";
import { SharedToolsContext, readFileTool, writeFileTool, grepTool, globTool, bashTool } from "./tools/shared.js";
import { AgentToolsContext, invokeAgentTool, makeMockAgentTool, invokeReviewerTool } from "./tools/agents.js";
import { WorkflowToolsContext, submitForConsensusTool, advancePhaseTool, getSessionStateTool, resolveCheckpointTool } from "./tools/workflow.js";
import {
  registerSessionTool,
  sendMessageTool,
  readMessagesTool,
  RegisterSessionParams,
  SendMessageParams,
  ReadMessagesParams,
  type PeerBusContext,
} from "./tools/peer-bus.js";
import { MessageStore } from "../core/message-store.js";
import { SessionRegistry } from "../core/session-registry.js";
import { AuditLogger } from "../core/audit.js";
import { WakeDispatcher } from "../core/wake-dispatcher.js";
import { TmuxWakeBackend } from "../core/wake-backends/tmux.js";
import { SessionManager } from "../core/session.js";
import { ConsensusLoop } from "../core/consensus.js";
import { AgentRegistry } from "../core/registry.js";
import { SpawnTracker } from "../core/spawn-tracker.js";
import { HumanCheckpoint } from "../core/checkpoint.js";
import type { Logger } from "../core/logger.js";

export interface CoordinatorServerOptions {
  config: McpConfig;
  session: SessionManager;
  logger: AuditLogger;
  consensus: ConsensusLoop;
  registry: AgentRegistry;
  spawnTracker: SpawnTracker;
  checkpoint: HumanCheckpoint;
  dryRun?: boolean;
  peerBus?: PeerBusWiring;
}

export interface PeerBusWiring {
  registry: SessionRegistry;
  store: MessageStore;
  logger: Logger;
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
  const presented = extractRequestToken(req);
  if (!presented) return false;
  const a = createHash("sha256").update(presented).digest();
  const b = createHash("sha256").update(expectedToken).digest();
  return timingSafeEqual(a, b);
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

  // --- Reviewer trigger tool ---

  server.tool(
    "invoke_reviewer",
    {
      reviewerId: z.string().describe("Reviewer ID from the reviewers block in mcp-config.json"),
      stage: z.enum(["spec", "code"]).describe("Which gate is running"),
      artifactContent: z.string().describe("Full content of the artifacts to review"),
    },
    async (params) => {
      const reviewer = config.reviewers[params.reviewerId];
      if (!reviewer) {
        return { content: [{ type: "text", text: JSON.stringify({ reviewerId: params.reviewerId, findings: [], error: `Reviewer '${params.reviewerId}' not found in config` }) }] };
      }
      if (!reviewer.cli) {
        return { content: [{ type: "text", text: JSON.stringify({ reviewerId: params.reviewerId, findings: [], error: `Reviewer '${params.reviewerId}' has no cli — use the Agent tool for Claude sub-agents` }) }] };
      }
      if (!reviewer.stage.includes(params.stage)) {
        return { content: [{ type: "text", text: JSON.stringify({ reviewerId: params.reviewerId, findings: [], error: `Reviewer '${params.reviewerId}' does not participate in the '${params.stage}' stage` }) }] };
      }

      const result = await invokeReviewerTool({
        reviewerId: params.reviewerId,
        reviewer,
        stage: params.stage,
        artifactContent: params.artifactContent,
      });

      if (result.timedOut) {
        logger.log({ type: "tool_call", tool: "invoke_reviewer", params: { reviewerId: params.reviewerId, stage: params.stage }, sessionId: session.get().sessionId, resultLength: 0, warning: "timeout" });
      } else {
        logger.log({ type: "tool_call", tool: "invoke_reviewer", params: { reviewerId: params.reviewerId, stage: params.stage }, sessionId: session.get().sessionId, resultLength: result.findings.length });
      }

      return { content: [{ type: "text", text: JSON.stringify(result) }] };
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

  // --- Peer bus tools (opt-in via peerBus.enabled) ---

  if (config.peerBus?.enabled === true && opts.peerBus !== undefined) {
    const autoWake = config.peerBus.autoWake;
    const peerRegistry = opts.peerBus.registry;
    const peerLogger = opts.peerBus.logger;

    // Revalidate persisted autoWakeKey values against the current allowlist.
    // Entries whose key is no longer in config are cleared in-memory with a
    // startup warn. registry.json is rewritten on next natural persist.
    const allowlistSet = autoWake !== undefined
      ? new Set(Object.keys(autoWake.allowedCommands))
      : null;
    const cleared = peerRegistry.revalidateAutoWakeKeys(allowlistSet);
    for (const { name, removedKey } of cleared) {
      peerLogger.warn("peer-bus: autoWakeKey cleared on load; key no longer in allowlist", {
        session: name,
        removedKey,
      });
    }

    // Build the wake dispatcher only when auto-wake is configured. The
    // dispatcher is optional on PeerBusContext — when absent, the live
    // bus behaves exactly as before this change (passive notifier only).
    let wakeDispatcher: WakeDispatcher | undefined;
    if (autoWake !== undefined && Object.keys(autoWake.allowedCommands).length > 0) {
      const backend = new TmuxWakeBackend({ allowedPaneCommands: autoWake.allowedPaneCommands });
      wakeDispatcher = new WakeDispatcher({
        registry: peerRegistry,
        backend,
        logger: peerLogger,
        audit: {
          log: (entry) => {
            logger.log({ type: "tool_call", sessionId: session.get().sessionId, ...entry });
          },
        },
        allowedCommands: autoWake.allowedCommands,
        debounceMs: autoWake.debounceMs,
      });
    }

    const peerCtx: PeerBusContext = {
      registry: peerRegistry,
      store: opts.peerBus.store,
      notifierConfig: config.peerBus.notifier,
      logger: peerLogger,
      audit: {
        log: (entry) => {
          logger.log({ type: "tool_call", sessionId: session.get().sessionId, ...entry });
        },
      },
      ...(autoWake !== undefined ? { autoWakeConfig: autoWake } : {}),
      ...(wakeDispatcher !== undefined ? { wakeDispatcher } : {}),
      ...(config.peerBus.session !== undefined
        ? { inactivityTtlMs: config.peerBus.session.inactivityTtlMs }
        : {}),
    };

    const allowlist = new Set(config.toolAllowlist);

    if (allowlist.has("register_session")) {
      server.tool(
        "register_session",
        RegisterSessionParams.shape,
        async (params) => registerSessionTool(peerCtx, params),
      );
    }

    if (allowlist.has("send_message")) {
      server.tool(
        "send_message",
        SendMessageParams.shape,
        async (params) => sendMessageTool(peerCtx, params),
      );
    }

    if (allowlist.has("read_messages")) {
      server.tool(
        "read_messages",
        ReadMessagesParams.shape,
        async (params) => readMessagesTool(peerCtx, params),
      );
    }
  }

  return server;
}

/**
 * Start the HTTP MCP transport. `serverFactory` is invoked PER SSE connection —
 * each client gets its own McpServer instance bound to its own SSE transport.
 * Shared state (session registry, message store, config) is captured in the
 * factory's closure, so every generated server sees the same backing data.
 *
 * The SDK's McpServer/Server enforces one-transport-per-instance; calling
 * `.connect()` twice on the same McpServer throws, so the factory-per-connection
 * pattern is mandatory for multi-client HTTP transport.
 */
export async function startHttpServer(
  serverFactory: () => McpServer,
  port: number,
  host = "127.0.0.1",
  authToken?: string
): Promise<() => void> {
  const app = express();
  const transports = new Map<string, SSEServerTransport>();
  const connectionServers = new Map<string, McpServer>();

  app.get("/sse", (req, res) => {
    if (!isAuthorizedRequest(req, authToken)) {
      res.status(401).send("Unauthorized");
      return;
    }
    const transport = new SSEServerTransport("/message", res);
    const server = serverFactory();
    transports.set(transport.sessionId, transport);
    connectionServers.set(transport.sessionId, server);
    res.on("close", () => {
      transports.delete(transport.sessionId);
      const conn = connectionServers.get(transport.sessionId);
      connectionServers.delete(transport.sessionId);
      if (conn !== undefined) {
        conn.close().catch((err: unknown) => {
          console.error("error closing per-connection MCP server:", err);
        });
      }
    });
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
    // express.json has already consumed the request stream, so pass the
    // parsed body as the third argument — the SSE transport will use it
    // instead of re-reading the (now empty) stream.
    transport.handlePostMessage(req, res, req.body).catch(console.error);
  });

  const httpServer = app.listen(port, host, () => {
    console.log(`Coordinator MCP server listening on http://${host}:${port}/sse`);
  });

  return () => httpServer.close();
}
