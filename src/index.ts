#!/usr/bin/env node
import { Command } from "commander";
import { execFile } from "child_process";
import { promisify } from "util";
import { access } from "fs/promises";
import { resolve } from "path";
import { loadConfig } from "./config.js";
import { SessionManager } from "./core/session.js";
import { AuditLogger } from "./core/audit.js";
import { SnapshotStore } from "./core/snapshot.js";
import { HumanCheckpoint } from "./core/checkpoint.js";
import { ConsensusLoop } from "./core/consensus.js";
import { AgentRegistry } from "./core/registry.js";
import { SpawnTracker } from "./core/spawn-tracker.js";
import { consoleLogger } from "./core/logger.js";
import { bootstrapPeerBus } from "./core/peer-bus-bootstrap.js";
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
    .description("Run the full teaming workflow (phase-driven; one-shot). For bus-only long-running operation see `serve`.")
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
        const bootstrap = await bootstrapPeerBus(opts.sessionsDir, sessionId, logger, consoleLogger);
        peerBusWiring = bootstrap.wiring;
        releaseCoordinatorLock = bootstrap.releaseLock;
        unregisterLockHandlers = bootstrap.unregisterHandlers;
      }

      const makeServer = (): ReturnType<typeof createCoordinatorServer> =>
        createCoordinatorServer({
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
        makeServer,
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
    .command("serve")
    .description("Run the coordinator for peer-bus-only operation (long-running; no workflow phases). For one-shot phase-driven workflow see `start`.")
    .option("--config <path>", "Path to MCP config file", "mcp-config.json")
    .option("--session <id>", "Resume an existing coordinator session")
    .option("--sessions-dir <path>", "Sessions storage directory", "./sessions")
    .action(async (opts: { config: string; session?: string; sessionsDir: string }) => {
      if (!(await fileExists(opts.config))) {
        console.error(`Error: config file not found: ${opts.config}`);
        process.exit(1);
      }

      const config = loadConfig(opts.config);
      config.rootDir = resolve(config.rootDir);

      if (config.peerBus?.enabled !== true) {
        console.error(
          "Error: `serve` requires `peerBus.enabled: true` in the config. Enable the peer bus or use `start` for phase-driven workflows."
        );
        process.exit(1);
      }

      if (!isLoopbackHost(config.host) && (!config.authTokenEnvVar || !process.env[config.authTokenEnvVar])) {
        console.error("Error: a transport auth token is required when binding the coordinator beyond loopback.");
        process.exit(1);
      }

      // Serve mode does NOT validate agent CLIs — no workflow runs.
      const registry = new AgentRegistry(config.agents);

      const session = opts.session
        ? await SessionManager.load(opts.sessionsDir, opts.session)
        : await SessionManager.create(opts.sessionsDir);
      const { sessionId } = session.get();
      const logger = new AuditLogger(opts.sessionsDir, sessionId);
      const snapshots = new SnapshotStore(opts.sessionsDir, sessionId);
      const checkpoint = new HumanCheckpoint(logger, sessionId, "proceed");
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

      const bootstrap = await bootstrapPeerBus(opts.sessionsDir, sessionId, logger, consoleLogger);

      const makeServer = (): ReturnType<typeof createCoordinatorServer> =>
        createCoordinatorServer({
          config,
          session,
          logger,
          consensus: consensusLoop,
          registry,
          spawnTracker,
          checkpoint,
          dryRun: false,
          peerBus: bootstrap.wiring,
        });

      const stopServer = await startHttpServer(
        makeServer,
        config.port,
        config.host,
        config.authTokenEnvVar ? process.env[config.authTokenEnvVar] : undefined
      );

      logger.log({ type: "serve_started", sessionId, port: config.port, host: config.host });
      console.log(`Coordinator serve mode running on http://${config.host}:${config.port}/sse (session ${sessionId})`);
      console.log("Press Ctrl+C to stop.");

      // Block until SIGINT/SIGTERM. The bootstrap already registered lock-cleanup
      // handlers on SIGINT/SIGTERM/exit/uncaughtException/unhandledRejection which
      // call process.exit() — our wait-promise resolves via a distinct listener
      // that also calls stopServer(). We use process.once to avoid double handling
      // if the lock-cleanup handler fires first.
      await new Promise<void>((resolveWait) => {
        const onSignal = (signal: NodeJS.Signals): void => {
          console.log(`\nReceived ${signal}, shutting down…`);
          resolveWait();
        };
        process.once("SIGINT", () => onSignal("SIGINT"));
        process.once("SIGTERM", () => onSignal("SIGTERM"));
      });

      try {
        stopServer();
      } catch (err) {
        console.error("stopServer error:", err);
      }
      try {
        bootstrap.unregisterHandlers();
      } catch {
        // ignore
      }
      try {
        bootstrap.releaseLock();
      } catch {
        // ignore
      }
      logger.log({ type: "serve_stopped", sessionId });
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
