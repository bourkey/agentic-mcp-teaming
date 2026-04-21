import * as fs from "fs";
import { join } from "path";
import type { Logger } from "./logger.js";

export const LOCK_FILENAME = "coordinator.lock";

export class CoordinatorLockError extends Error {
  readonly code = "coordinator_lock_held";
  constructor(public readonly lockPath: string, public readonly priorContent: string | null) {
    super(
      `coordinator.lock already exists at ${lockPath}` +
        (priorContent !== null ? ` (prior content: ${priorContent.trim()})` : "")
    );
  }
}

export interface AcquiredLock {
  release: () => void;
  path: string;
}

export function acquireCoordinatorLock(sessionsDir: string, logger: Logger): AcquiredLock {
  const lockPath = join(sessionsDir, LOCK_FILENAME);
  let fd: number;
  try {
    fd = fs.openSync(lockPath, "wx");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") {
      let priorContent: string | null = null;
      try {
        priorContent = fs.readFileSync(lockPath, "utf8");
      } catch {
        // ignore read errors; we still throw EEXIST
      }
      throw new CoordinatorLockError(lockPath, priorContent);
    }
    throw err;
  }

  const content = `pid=${process.pid}\n`;
  try {
    fs.writeSync(fd, content);
  } finally {
    fs.closeSync(fd);
  }

  let released = false;
  const ownPid = process.pid;
  const release = (): void => {
    if (released) return;
    released = true;
    let current: string | null = null;
    try {
      current = fs.readFileSync(lockPath, "utf8");
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT") return;
      logger.warn("coordinator-lock: failed to read lock on release", { error: (err as Error).message });
      return;
    }
    if (current.trim() !== `pid=${ownPid}`) {
      logger.warn("coordinator-lock: PID mismatch on release; leaving lock alone", {
        expected: `pid=${ownPid}`,
        actual: current.trim(),
      });
      return;
    }
    try {
      fs.unlinkSync(lockPath);
    } catch (err) {
      logger.warn("coordinator-lock: unlink failed on release", { error: (err as Error).message });
    }
  };

  return { release, path: lockPath };
}

/**
 * Register cleanup handlers so the lock is released on every Node exit path.
 * Returns a function that removes the handlers (useful for tests).
 */
export function registerLockCleanupHandlers(release: () => void, logger: Logger): () => void {
  const onSignal = (signal: NodeJS.Signals) => {
    logger.info("coordinator-lock: signal received, releasing", { signal });
    release();
    process.exit(0);
  };
  const onExit = () => release();
  const onUncaught = (err: Error) => {
    logger.error("coordinator-lock: uncaughtException, releasing", { error: err.message });
    release();
    process.exit(1);
  };
  const onRejection = (reason: unknown) => {
    logger.error("coordinator-lock: unhandledRejection, releasing", {
      reason: reason instanceof Error ? reason.message : String(reason),
    });
    release();
    process.exit(1);
  };

  const sigint = () => onSignal("SIGINT");
  const sigterm = () => onSignal("SIGTERM");

  process.on("SIGINT", sigint);
  process.on("SIGTERM", sigterm);
  process.on("exit", onExit);
  process.on("uncaughtException", onUncaught);
  process.on("unhandledRejection", onRejection);

  return () => {
    process.off("SIGINT", sigint);
    process.off("SIGTERM", sigterm);
    process.off("exit", onExit);
    process.off("uncaughtException", onUncaught);
    process.off("unhandledRejection", onRejection);
  };
}
