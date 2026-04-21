import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import * as fs from "fs";
import { bootstrapPeerBus } from "../src/core/peer-bus-bootstrap.js";
import { CoordinatorLockError } from "../src/core/coordinator-lock.js";
import { AuditLogger } from "../src/core/audit.js";
import type { Logger } from "../src/core/logger.js";

function makeCapturingLogger(): { logger: Logger; warns: Array<Record<string, unknown>> } {
  const warns: Array<Record<string, unknown>> = [];
  const logger: Logger = {
    info: () => {},
    warn: (message, meta) => { warns.push({ message, ...(meta ?? {}) }); },
    error: () => {},
  };
  return { logger, warns };
}

let sessionsDir: string;
const sessionId = "test-session";

beforeEach(async () => {
  sessionsDir = await mkdtemp(join(tmpdir(), "bootstrap-test-"));
});

afterEach(async () => {
  await rm(sessionsDir, { recursive: true, force: true });
});

describe("bootstrapPeerBus", () => {
  it("acquires lock, touches messages.jsonl, creates registry.json, returns wiring", async () => {
    const audit = new AuditLogger(sessionsDir, sessionId);
    const { logger } = makeCapturingLogger();

    const result = await bootstrapPeerBus(sessionsDir, sessionId, audit, logger);
    try {
      const sessionDir = join(sessionsDir, sessionId);
      expect(fs.existsSync(join(sessionDir, "coordinator.lock"))).toBe(true);
      expect(fs.existsSync(join(sessionDir, "messages.jsonl"))).toBe(true);
      expect(fs.existsSync(join(sessionDir, "registry.json"))).toBe(true);
      expect(result.wiring.registry).toBeDefined();
      expect(result.wiring.store).toBeDefined();
      expect(result.reconciliation.orphanedCount).toBe(0);
      expect(result.reconciliation.misroutedCount).toBe(0);
    } finally {
      result.unregisterHandlers();
      result.releaseLock();
    }
  });

  it("second bootstrap against the same session dir throws CoordinatorLockError", async () => {
    const audit = new AuditLogger(sessionsDir, sessionId);
    const { logger } = makeCapturingLogger();
    const first = await bootstrapPeerBus(sessionsDir, sessionId, audit, logger);
    try {
      await expect(
        bootstrapPeerBus(sessionsDir, sessionId, audit, logger)
      ).rejects.toBeInstanceOf(CoordinatorLockError);
    } finally {
      first.unregisterHandlers();
      first.releaseLock();
    }
  });

  it("releaseLock removes the lock file and allows a subsequent bootstrap", async () => {
    const audit = new AuditLogger(sessionsDir, sessionId);
    const { logger } = makeCapturingLogger();
    const first = await bootstrapPeerBus(sessionsDir, sessionId, audit, logger);
    first.unregisterHandlers();
    first.releaseLock();
    expect(fs.existsSync(join(sessionsDir, sessionId, "coordinator.lock"))).toBe(false);

    const second = await bootstrapPeerBus(sessionsDir, sessionId, audit, logger);
    try {
      expect(fs.existsSync(join(sessionsDir, sessionId, "coordinator.lock"))).toBe(true);
    } finally {
      second.unregisterHandlers();
      second.releaseLock();
    }
  });
});
