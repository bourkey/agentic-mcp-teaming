import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import * as fs from "fs";
import {
  acquireCoordinatorLock,
  CoordinatorLockError,
  LOCK_FILENAME,
} from "../src/core/coordinator-lock.js";
import type { Logger } from "../src/core/logger.js";

function makeLogger(): {
  logger: Logger;
  warnings: Array<{ message: string; meta: Record<string, unknown> | undefined }>;
} {
  const warnings: Array<{ message: string; meta: Record<string, unknown> | undefined }> = [];
  const logger: Logger = {
    info: () => {},
    warn: (message, meta) => { warnings.push({ message, meta }); },
    error: () => {},
  };
  return { logger, warnings };
}

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "coord-lock-test-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("acquireCoordinatorLock", () => {
  it("acquires when no lock exists and writes PID", () => {
    const { logger } = makeLogger();
    const lock = acquireCoordinatorLock(dir, logger);
    expect(fs.existsSync(lock.path)).toBe(true);
    expect(fs.readFileSync(lock.path, "utf8").trim()).toBe(`pid=${process.pid}`);
    lock.release();
    expect(fs.existsSync(lock.path)).toBe(false);
  });

  it("throws CoordinatorLockError when a lock exists held by a live PID", () => {
    const lockPath = join(dir, LOCK_FILENAME);
    // Use the current process PID — guaranteed to be alive, so stale-lock detection must not trigger.
    fs.writeFileSync(lockPath, `pid=${process.pid}\n`, "utf8");
    const { logger } = makeLogger();
    try {
      acquireCoordinatorLock(dir, logger);
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(CoordinatorLockError);
      expect((err as CoordinatorLockError).lockPath).toBe(lockPath);
      expect((err as CoordinatorLockError).priorContent).toContain(`pid=${process.pid}`);
    }
  });

  it("clears a stale lock (dead PID) and acquires successfully", () => {
    const lockPath = join(dir, LOCK_FILENAME);
    // PID 1 on macOS is launchd and always alive; use a PID that is guaranteed
    // dead by writing one that no sane OS would have running: max+1 wraps to 0
    // which is also invalid. We use a fixed high PID that's extremely unlikely
    // to exist and verify via process.kill before trusting the test.
    const deadPid = 999999;
    let pidAlive = false;
    try { process.kill(deadPid, 0); pidAlive = true; } catch { /* expected */ }
    if (pidAlive) return; // skip if somehow the PID is live in this environment
    fs.writeFileSync(lockPath, `pid=${deadPid}\n`, "utf8");
    const { logger, warnings } = makeLogger();
    const lock = acquireCoordinatorLock(dir, logger);
    expect(fs.existsSync(lock.path)).toBe(true);
    expect(fs.readFileSync(lock.path, "utf8").trim()).toBe(`pid=${process.pid}`);
    expect(warnings.some(w => w.message.includes("stale lock"))).toBe(true);
    lock.release();
  });

  it("release is idempotent", () => {
    const { logger } = makeLogger();
    const lock = acquireCoordinatorLock(dir, logger);
    lock.release();
    // second release should not throw
    lock.release();
    expect(fs.existsSync(lock.path)).toBe(false);
  });

  it("release refuses to unlink a lock with mismatched PID", () => {
    const { logger, warnings } = makeLogger();
    const lock = acquireCoordinatorLock(dir, logger);
    // Simulate another process replacing the lock
    fs.writeFileSync(lock.path, "pid=99999\n", "utf8");
    lock.release();
    expect(fs.existsSync(lock.path)).toBe(true);
    expect(warnings.length).toBe(1);
  });

  it("second acquire after clean release succeeds", () => {
    const { logger } = makeLogger();
    const first = acquireCoordinatorLock(dir, logger);
    first.release();
    const second = acquireCoordinatorLock(dir, logger);
    expect(fs.existsSync(second.path)).toBe(true);
    second.release();
  });

  it("release tolerates lock file already deleted", () => {
    const { logger } = makeLogger();
    const lock = acquireCoordinatorLock(dir, logger);
    fs.unlinkSync(lock.path);
    // should not throw
    lock.release();
  });
});
