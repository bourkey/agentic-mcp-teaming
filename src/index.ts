import { Command } from "commander";
import { execFile } from "child_process";
import { promisify } from "util";
import { access, mkdir } from "fs/promises";
import { resolve, join } from "path";
import { loadConfig } from "./config.js";
import { SessionManager } from "./core/session.js";
import { AuditLogger } from "./core/audit.js";
import { SnapshotStore } from "./core/snapshot.js";
import { HumanCheckpoint } from "./core/checkpoint.js";
import { ConsensusLoop } from "./core/consensus.js";
import { AgentRegistry } from "./core/registry.js";
import { SpawnTracker } from "./core/spawn-tracker.js";
import { MessageStore } from "./core/message-store.js";
import { SessionRegistry } from "./core/session-registry.js";
import { consoleLogger } from "./core/logger.js";
import {
  acquireCoordinatorLock,
  registerLockCleanupHandlers,
} from "./core/coordinator-lock.js";
import { AgentToolsContext } from "./server/tools/agents.js";
import { createCoordinatorServer, startHttpServer, type PeerBusWiring } from "./server/index.js";
import { runProposalPhase } from "./phases/proposal.js";
import { runDesignPhase } from "./phases/design.js";
import { runSpecsPhase } from "./phases/specs.js";
import { runTasksPhase } from "./phases/tasks.js";
import { ImplementationPhase } from "./phases/implementation.js";

const execFileAsync = promisify(execFile);

async function fileExists(path: string): Promise<boolean> {
  try { await access(path); return true; } catch { return false; }
}

async function validateRegistryClis(registry: AgentRegistry): Promise<void> {
  for (const [agentId, entry] of registry.all()) {
    try {
      await execFileAsync("which", [entry.cli]);
    } catch {
      console.error(`Error: CLI not found for agent "${agentId}": ${entry.cli}`);
      process.exit(1);
    }
  }
}

async function validateGit(repoRoot: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", ["rev-parse", "--is-inside-work-tree"], { cwd: repoRoot });
    if (stdout.trim() !== "true") throw new Error("not in git repo");
  } catch {
    console.error("Error: not inside a Git repository. Git is required for implementation phase.");
    process.exit(1);
  }
  const { stdout: statusOut } = await execFileAsync("git", ["status", "--porcelain"], { cwd: repoRoot });
  if (statusOut.trim()) {
    console.error("Error: working tree has uncommitted changes. Please commit or stash before running.");
    process.exit(1);
  }
  const { stdout: branch } = await execFileAsync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: repoRoot });
  return branch.trim();
}

function isLoopbackHost(host: string): boolean {
  return host === "127.0.0.1" || host === "localhost" || host === "::1";
}

function requiresGitForWorkflow(phase: string): boolean {
  return phase === "implementation";
}

async function main(): Promise<void> {
  const program = new Command();

  program
    .name("agentic-mcp-teaming")
    .description("Multi-agent teaming coordinator via MCP")
    .version("0.1.0");

  program
    .command("start")
    .description("Run the full teaming workflow")
    .option("--workflow <phase>", "Starting workflow phase", "proposal")
    .option("--session <id>", "Resume an existing session by ID")
    .option("--dry-run", "Use mock agents (no real CLI calls)")
    .option("--config <path>", "Path to mcp-config.json", "mcp-config.json")
    .option("--sessions-dir <path>", "Sessions storage directory", "./sessions")
    .option("--openspec-dir <path>", "OpenSpec change directory", "./openspec/changes/claude-codex-teaming")
    .action(async (opts: {
      workflow: string;
      session?: string;
      dryRun?: boolean;
      config: string;
      sessionsDir: string;
      openspecDir: string;
    }) => {
      if (!(await fileExists(opts.config))) {
        console.error(`Error: config file not found: ${opts.config}`);
        process.exit(1);
      }

      const config = loadConfig(opts.config);
      config.rootDir = resolve(config.rootDir);
      if (!isLoopbackHost(config.host) && (!config.authTokenEnvVar || !process.env[config.authTokenEnvVar])) {
        console.error("Error: a transport auth token is required when binding the coordinator beyond loopback.");
        process.exit(1);
      }

      // Build registry and validate CLIs at startup
      const registry = new AgentRegistry(config.agents);
      if (!opts.dryRun) {
        await validateRegistryClis(registry);
      }

      const sessionBranch = `teaming-session-${Date.now()}`;
      const session = opts.session
        ? await SessionManager.load(opts.sessionsDir, opts.session)
        : await SessionManager.create(opts.sessionsDir);

      const { sessionId } = session.get();
      const logger = new AuditLogger(opts.sessionsDir, sessionId);
      const snapshots = new SnapshotStore(opts.sessionsDir, sessionId);
      const checkpoint = new HumanCheckpoint(logger, sessionId, opts.dryRun ? "proceed" : undefined);

      // Restore spawn stats from session (for resume)
      const spawnTracker = new SpawnTracker(config.spawning, session.get().spawnStats);

      const agentCtx: AgentToolsContext = {
        registry,
        spawnTracker,
        timeoutMs: 120_000,
        logger,
        sessionId,
        phase: session.get().currentPhase,
        checkpoint,
        coordinatorUrl: `http://${config.host}:${config.port}/sse`,
        ...(config.authTokenEnvVar && process.env[config.authTokenEnvVar]
          ? { coordinatorAuthToken: process.env[config.authTokenEnvVar]! }
          : {}),
        persistSpawnStats: async (stats) => {
          await session.update({ spawnStats: stats });
        },
      };

      const reviserAgentId = registry.revisers()[0];
      const consensusLoop = new ConsensusLoop(agentCtx, session, logger, snapshots, checkpoint, {
        maxRounds: config.consensus.maxRounds,
        reviewerAgentIds: registry.reviewers(),
        ...(reviserAgentId !== undefined ? { reviserAgentId } : {}),
      });

      const phaseCtx = { session, logger, consensus: consensusLoop, checkpoint, registry };

      // Peer-bus wiring (opt-in via peerBus.enabled)
      let peerBusWiring: PeerBusWiring | undefined;
      let releaseCoordinatorLock: (() => void) | undefined;
      let unregisterLockHandlers: (() => void) | undefined;
      if (config.peerBus?.enabled === true) {
        const sessionDir = join(opts.sessionsDir, sessionId);
        await mkdir(sessionDir, { recursive: true });
        const lock = acquireCoordinatorLock(sessionDir, consoleLogger);
        releaseCoordinatorLock = lock.release;
        unregisterLockHandlers = registerLockCleanupHandlers(lock.release, consoleLogger);

        const registryPath = join(sessionDir, "registry.json");
        const messagesPath = join(sessionDir, "messages.jsonl");

        // Touch-initialise persistence files so clients see them immediately.
        const { appendFile } = await import("fs/promises");
        await appendFile(messagesPath, "");

        const peerRegistry = new SessionRegistry(registryPath, consoleLogger);
        await peerRegistry.load();
        const peerStore = new MessageStore(messagesPath, consoleLogger);

        // Reconciliation: drop orphaned / misrouted unread ids.
        const messageLookup = await peerStore.loadAll();
        const summary = peerRegistry.reconcile(messageLookup);
        if (summary.orphanedCount > 0 || summary.misroutedCount > 0) {
          logger.log({
            type: "peer_bus_reconciliation",
            sessionId,
            orphanedCount: summary.orphanedCount,
            misroutedCount: summary.misroutedCount,
            firstFewIds: summary.firstFewIds,
          });
        }
        // Always persist registry.json on startup so the file exists before connections land.
        await peerRegistry.persist();

        peerBusWiring = { registry: peerRegistry, store: peerStore, logger: consoleLogger };
      }

      const server = createCoordinatorServer({
        config,
        session,
        logger,
        consensus: consensusLoop,
        registry,
        spawnTracker,
        checkpoint,
        dryRun: opts.dryRun === true,
        ...(peerBusWiring !== undefined ? { peerBus: peerBusWiring } : {}),
      });
      const stopServer = await startHttpServer(
        server,
        config.port,
        config.host,
        config.authTokenEnvVar ? process.env[config.authTokenEnvVar] : undefined
      );

      logger.log({ type: "session_start", sessionId, dryRun: !!opts.dryRun, startPhase: opts.workflow });

      try {
        const specsDir = `${opts.openspecDir}/specs`;
        const proposalPath = `${opts.openspecDir}/proposal.md`;
        const designPath = `${opts.openspecDir}/design.md`;
        const tasksPath = `${opts.openspecDir}/tasks.md`;

        if (opts.workflow === "proposal" || session.get().currentPhase === "proposal") {
          await runProposalPhase(phaseCtx, proposalPath);
        }
        if (session.get().currentPhase === "design") {
          await runDesignPhase(phaseCtx, designPath);
        }
        if (session.get().currentPhase === "spec") {
          await runSpecsPhase(phaseCtx, specsDir);
        }
        if (session.get().currentPhase === "task") {
          const assignments = await runTasksPhase(phaseCtx, tasksPath);
          if (session.get().currentPhase === "implementation") {
            if (requiresGitForWorkflow("implementation")) {
              await validateGit(config.rootDir);
            }
            await execFileAsync("git", ["checkout", "-b", sessionBranch], { cwd: config.rootDir });
            await session.update({ implBranch: sessionBranch });
            const impl = new ImplementationPhase(phaseCtx, { repoRoot: config.rootDir, sessionBranch }, agentCtx);
            await impl.run(assignments);
          }
        }

        console.log(`\nWorkflow complete. Session: ${sessionId}`);
        logger.log({ type: "session_complete", sessionId });
      } catch (err) {
        console.error("Workflow error:", err);
        logger.log({ type: "session_error", error: String(err), sessionId });
        process.exit(1);
      } finally {
        stopServer();
        if (unregisterLockHandlers !== undefined) unregisterLockHandlers();
        if (releaseCoordinatorLock !== undefined) releaseCoordinatorLock();
      }
    });

  program
    .command("status")
    .description("Show current session state")
    .requiredOption("--session <id>", "Session ID")
    .option("--sessions-dir <path>", "Sessions storage directory", "./sessions")
    .action(async (opts: { session: string; sessionsDir: string }) => {
      const session = await SessionManager.load(opts.sessionsDir, opts.session);
      console.log(JSON.stringify(session.get(), null, 2));
    });

  await program.parseAsync(process.argv);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
