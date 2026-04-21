import { mkdir, appendFile } from "fs/promises";
import { join } from "path";
import { acquireCoordinatorLock, registerLockCleanupHandlers } from "./coordinator-lock.js";
import { MessageStore } from "./message-store.js";
import { SessionRegistry } from "./session-registry.js";
import { consoleLogger, type Logger } from "./logger.js";
import type { PeerBusWiring } from "../server/index.js";
import type { AuditLogger } from "./audit.js";

export interface BootstrapResult {
  wiring: PeerBusWiring;
  releaseLock: () => void;
  unregisterHandlers: () => void;
  reconciliation: { orphanedCount: number; misroutedCount: number; firstFewIds: string[] };
}

/**
 * Bring the peer bus online for a coordinator session.
 *
 * Shared bootstrap used by both the phase-driven `start` subcommand and the
 * bus-only `serve` subcommand: acquire the coordinator lock, touch
 * `messages.jsonl`, load `registry.json`, reconcile any unread ids against
 * the log, and return the wiring for injection into the MCP server.
 *
 * The auditLogger parameter is the session's AuditLogger (which writes to
 * `audit.log` under the session dir) and is used to record the reconciliation
 * summary. The returned wiring.logger is a plain Logger for the peer-bus
 * modules that prefer a generic console-style interface.
 */
export async function bootstrapPeerBus(
  sessionsDir: string,
  sessionId: string,
  auditLogger: AuditLogger,
  logger: Logger = consoleLogger
): Promise<BootstrapResult> {
  const sessionDir = join(sessionsDir, sessionId);
  await mkdir(sessionDir, { recursive: true });

  const lock = acquireCoordinatorLock(sessionDir, logger);
  const unregisterHandlers = registerLockCleanupHandlers(lock.release, logger);

  const registryPath = join(sessionDir, "registry.json");
  const messagesPath = join(sessionDir, "messages.jsonl");

  // Touch-initialise the log so clients see it immediately after startup.
  await appendFile(messagesPath, "");

  const registry = new SessionRegistry(registryPath, logger);
  await registry.load();
  const store = new MessageStore(messagesPath, logger);

  const messageLookup = await store.loadAll();
  const summary = registry.reconcile(messageLookup);
  if (summary.orphanedCount > 0 || summary.misroutedCount > 0) {
    auditLogger.log({
      type: "peer_bus_reconciliation",
      sessionId,
      orphanedCount: summary.orphanedCount,
      misroutedCount: summary.misroutedCount,
      firstFewIds: summary.firstFewIds,
    });
  }

  // Persist unconditionally so registry.json exists before accepting connections.
  await registry.persist();

  return {
    wiring: { registry, store, logger },
    releaseLock: lock.release,
    unregisterHandlers,
    reconciliation: summary,
  };
}
