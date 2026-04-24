import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { WakeDispatcher, type WakeAuditor } from "../src/core/wake-dispatcher.js";
import { SessionRegistry } from "../src/core/session-registry.js";
import type { WakeBackend } from "../src/core/wake-backend.js";
import type { Logger } from "../src/core/logger.js";

function makeLogger() {
  const warnings: Array<{ message: string; meta: Record<string, unknown> | undefined }> = [];
  const errors: Array<{ message: string; meta: Record<string, unknown> | undefined }> = [];
  const logger: Logger = {
    info: () => {},
    warn: (message, meta) => { warnings.push({ message, meta }); },
    error: (message, meta) => { errors.push({ message, meta }); },
  };
  return { logger, warnings, errors };
}

function makeAuditor() {
  const entries: Record<string, unknown>[] = [];
  const audit: WakeAuditor = { log: (e) => { entries.push(e); } };
  return { audit, entries };
}

function makeBackend(overrides: Partial<WakeBackend> = {}): {
  backend: WakeBackend;
  paneCalls: string[];
  sendCalls: Array<{ target: string; cmd: string }>;
} {
  const paneCalls: string[] = [];
  const sendCalls: Array<{ target: string; cmd: string }> = [];
  const backend: WakeBackend = {
    isPaneStateSafe: overrides.isPaneStateSafe ?? (async (target) => {
      paneCalls.push(target);
      return { safe: true, currentCommand: "bash" };
    }),
    sendKeys: overrides.sendKeys ?? (async (target, cmd) => {
      sendCalls.push({ target, cmd });
    }),
  };
  return { backend, paneCalls, sendCalls };
}

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "wake-dispatcher-test-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function makeRegistry(): Promise<SessionRegistry> {
  const { logger } = makeLogger();
  return new SessionRegistry(join(dir, "registry.json"), logger);
}

const ALLOWLIST = { "claude-inbox": "/opsx:peer-inbox" };

describe("WakeDispatcher: opt-in gating", () => {
  it("is a no-op for recipients without autoWakeKey", async () => {
    const registry = await makeRegistry();
    registry.register("main");
    const { backend, paneCalls, sendCalls } = makeBackend();
    const { audit, entries } = makeAuditor();
    const { logger } = makeLogger();

    const d = new WakeDispatcher({ registry, backend, logger, audit, allowedCommands: ALLOWLIST, debounceMs: 1000 });
    await d.maybeDispatch({ target: "main", messageId: "m1" });

    expect(paneCalls).toEqual([]);
    expect(sendCalls).toEqual([]);
    expect(entries).toEqual([]);
  });

  it("dispatches when recipient is opted in and pane is safe", async () => {
    const registry = await makeRegistry();
    registry.register("main", undefined, "claude-inbox");
    const { backend, paneCalls, sendCalls } = makeBackend();
    const { audit, entries } = makeAuditor();
    const { logger } = makeLogger();

    const d = new WakeDispatcher({ registry, backend, logger, audit, allowedCommands: ALLOWLIST, debounceMs: 1000 });
    await d.maybeDispatch({ target: "main", messageId: "m1" });

    expect(paneCalls).toEqual(["main"]);
    expect(sendCalls).toEqual([{ target: "main", cmd: "/opsx:peer-inbox" }]);

    const dispatched = entries.find((e) => e["type"] === "wake_dispatched")!;
    expect(dispatched["status"]).toBe("ok");
    expect(dispatched["target"]).toBe("main");
    expect(dispatched["commandKey"]).toBe("claude-inbox");
    expect(dispatched["messageId"]).toBe("m1");
    expect(typeof dispatched["dispatchedAt"]).toBe("string");
    expect(String(dispatched["dispatchedAt"])).toMatch(/Z$/);
    // Resolved command string must NOT appear in audit
    expect(JSON.stringify(dispatched)).not.toContain("/opsx:peer-inbox");

    expect(registry.getWakeState("main").wakesDispatched).toBe(1);
    expect(registry.getWakeState("main").wakesSuppressed).toBe(0);
    expect(registry.getWakeState("main").wakesFailed).toBe(0);
  });
});

describe("WakeDispatcher: pane-state safety gate", () => {
  it("suppresses dispatch when pane is unsafe; emits wake_suppressed", async () => {
    const registry = await makeRegistry();
    registry.register("main", undefined, "claude-inbox");
    const { backend, sendCalls } = makeBackend({
      isPaneStateSafe: async () => ({ safe: false, currentCommand: "sudo" }),
    });
    const { audit, entries } = makeAuditor();
    const { logger } = makeLogger();

    const d = new WakeDispatcher({ registry, backend, logger, audit, allowedCommands: ALLOWLIST, debounceMs: 1000 });
    await d.maybeDispatch({ target: "main", messageId: "m1" });

    expect(sendCalls).toEqual([]);
    const suppressed = entries.find((e) => e["type"] === "wake_suppressed")!;
    expect(suppressed["reason"]).toBe("pane_state_unsafe");
    expect(suppressed["currentCommand"]).toBe("sudo");
    expect(registry.getWakeState("main").wakesSuppressed).toBe(1);
    // Pane-unsafe suppression MUST NOT update the debounce window
    expect(registry.getWakeState("main").lastDispatchedAt).toBeUndefined();
  });

  it("does not update debounce on pane-unsafe so next message dispatches immediately", async () => {
    const registry = await makeRegistry();
    registry.register("main", undefined, "claude-inbox");
    let firstCall = true;
    const { backend, sendCalls } = makeBackend({
      isPaneStateSafe: async () => {
        if (firstCall) { firstCall = false; return { safe: false, currentCommand: "sudo" }; }
        return { safe: true, currentCommand: "bash" };
      },
    });
    const { audit } = makeAuditor();
    const { logger } = makeLogger();

    const d = new WakeDispatcher({ registry, backend, logger, audit, allowedCommands: ALLOWLIST, debounceMs: 60000 });
    await d.maybeDispatch({ target: "main", messageId: "m1" });
    await d.maybeDispatch({ target: "main", messageId: "m2" });

    expect(sendCalls).toHaveLength(1);
    expect(sendCalls[0]?.target).toBe("main");
  });
});

describe("WakeDispatcher: stale allowlist key", () => {
  it("emits wake_suppressed { reason: 'key_no_longer_in_allowlist' } when the stored key is gone", async () => {
    const registry = await makeRegistry();
    registry.register("main", undefined, "stale-key");
    const { backend, sendCalls } = makeBackend();
    const { audit, entries } = makeAuditor();
    const { logger } = makeLogger();

    const d = new WakeDispatcher({ registry, backend, logger, audit, allowedCommands: ALLOWLIST, debounceMs: 1000 });
    await d.maybeDispatch({ target: "main", messageId: "m1" });

    expect(sendCalls).toEqual([]);
    const suppressed = entries.find((e) => e["type"] === "wake_suppressed")!;
    expect(suppressed["reason"]).toBe("key_no_longer_in_allowlist");
    expect(suppressed["commandKey"]).toBe("stale-key");
    expect(registry.getWakeState("main").wakesSuppressed).toBe(1);
  });
});

describe("WakeDispatcher: debounce", () => {
  it("burst of 5 messages produces 1 dispatch and 4 suppressions", async () => {
    const registry = await makeRegistry();
    registry.register("main", undefined, "claude-inbox");
    const { backend, sendCalls } = makeBackend();
    const { audit, entries } = makeAuditor();
    const { logger } = makeLogger();

    const d = new WakeDispatcher({ registry, backend, logger, audit, allowedCommands: ALLOWLIST, debounceMs: 60000 });
    for (let i = 0; i < 5; i++) await d.maybeDispatch({ target: "main", messageId: `m${i}` });

    expect(sendCalls).toHaveLength(1);
    const dispatched = entries.filter((e) => e["type"] === "wake_dispatched");
    const suppressed = entries.filter((e) => e["type"] === "wake_suppressed");
    expect(dispatched).toHaveLength(1);
    expect(suppressed).toHaveLength(4);
    expect(suppressed.every((e) => e["reason"] === "debounce")).toBe(true);
    expect(registry.getWakeState("main").wakesDispatched).toBe(1);
    expect(registry.getWakeState("main").wakesSuppressed).toBe(4);
  });

  it("concurrent recipients do not block each other", async () => {
    const registry = await makeRegistry();
    registry.register("main", undefined, "claude-inbox");
    registry.register("backend", undefined, "claude-inbox");
    const { backend, sendCalls } = makeBackend();
    const { audit } = makeAuditor();
    const { logger } = makeLogger();

    const d = new WakeDispatcher({ registry, backend, logger, audit, allowedCommands: ALLOWLIST, debounceMs: 60000 });
    await Promise.all([
      d.maybeDispatch({ target: "main", messageId: "m1" }),
      d.maybeDispatch({ target: "backend", messageId: "m2" }),
    ]);

    expect(sendCalls).toHaveLength(2);
    expect(sendCalls.map((c) => c.target).sort()).toEqual(["backend", "main"]);
  });

  it("messages spaced beyond debounce window both dispatch", async () => {
    const registry = await makeRegistry();
    registry.register("main", undefined, "claude-inbox");
    const { backend, sendCalls } = makeBackend();
    const { audit } = makeAuditor();
    const { logger } = makeLogger();

    const d = new WakeDispatcher({ registry, backend, logger, audit, allowedCommands: ALLOWLIST, debounceMs: 100 });
    await d.maybeDispatch({ target: "main", messageId: "m1" });
    await new Promise((r) => setTimeout(r, 120));
    await d.maybeDispatch({ target: "main", messageId: "m2" });

    expect(sendCalls).toHaveLength(2);
  });

  it("same-tick concurrency via Promise.all produces exactly one dispatch", async () => {
    const registry = await makeRegistry();
    registry.register("main", undefined, "claude-inbox");
    const { backend, sendCalls } = makeBackend();
    const { audit, entries } = makeAuditor();
    const { logger } = makeLogger();

    const d = new WakeDispatcher({ registry, backend, logger, audit, allowedCommands: ALLOWLIST, debounceMs: 60000 });
    await Promise.all([
      d.maybeDispatch({ target: "main", messageId: "m1" }),
      d.maybeDispatch({ target: "main", messageId: "m2" }),
      d.maybeDispatch({ target: "main", messageId: "m3" }),
    ]);

    expect(sendCalls).toHaveLength(1);
    const suppressed = entries.filter((e) => e["type"] === "wake_suppressed");
    expect(suppressed).toHaveLength(2);
  });

  it("failed dispatch updates debounce timestamp so next message suppresses", async () => {
    const registry = await makeRegistry();
    registry.register("main", undefined, "claude-inbox");
    let firstCall = true;
    const { backend } = makeBackend({
      sendKeys: async () => {
        if (firstCall) {
          firstCall = false;
          const err = Object.assign(new Error("tmux fail"), { exitCode: 1, signal: null });
          throw err;
        }
      },
    });
    const { audit, entries } = makeAuditor();
    const { logger } = makeLogger();

    const d = new WakeDispatcher({ registry, backend, logger, audit, allowedCommands: ALLOWLIST, debounceMs: 60000 });
    await d.maybeDispatch({ target: "main", messageId: "m1" });
    await d.maybeDispatch({ target: "main", messageId: "m2" });

    // First call: failed dispatch, still consumed window
    const dispatched = entries.filter((e) => e["type"] === "wake_dispatched");
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]?.["status"]).toBe("failed");

    // Second call: suppressed by debounce
    const suppressed = entries.filter((e) => e["type"] === "wake_suppressed");
    expect(suppressed).toHaveLength(1);
    expect(suppressed[0]?.["reason"]).toBe("debounce");
  });
});

describe("WakeDispatcher: failure handling", () => {
  it("logs warn with exitCode/signal and audits wake_dispatched { status: 'failed' }", async () => {
    const registry = await makeRegistry();
    registry.register("main", undefined, "claude-inbox");
    const { backend } = makeBackend({
      sendKeys: async () => {
        const err = Object.assign(new Error("tmux fail"), { exitCode: 1, signal: null });
        throw err;
      },
    });
    const { audit, entries } = makeAuditor();
    const { logger, warnings } = makeLogger();

    const d = new WakeDispatcher({ registry, backend, logger, audit, allowedCommands: ALLOWLIST, debounceMs: 1000 });
    await d.maybeDispatch({ target: "main", messageId: "m1" });

    const warn = warnings.find((w) => w.message.includes("send-keys failed"));
    expect(warn).toBeTruthy();
    expect(warn!.meta).toMatchObject({ target: "main", commandKey: "claude-inbox", exitCode: 1 });
    // Warn MUST NOT contain the resolved string
    expect(JSON.stringify(warn)).not.toContain("/opsx:peer-inbox");

    const dispatched = entries.find((e) => e["type"] === "wake_dispatched")!;
    expect(dispatched["status"]).toBe("failed");
    expect(dispatched["exitCode"]).toBe(1);
    expect(JSON.stringify(dispatched)).not.toContain("/opsx:peer-inbox");

    expect(registry.getWakeState("main").wakesFailed).toBe(1);
  });
});

describe("WakeDispatcher: probe throws", () => {
  it("treats a probe that throws as unsafe; emits wake_suppressed and does not dispatch", async () => {
    const registry = await makeRegistry();
    registry.register("main", undefined, "claude-inbox");
    const { backend, sendCalls } = makeBackend({
      isPaneStateSafe: async () => { throw new Error("tmux gone"); },
    });
    const { audit, entries } = makeAuditor();
    const { logger, warnings } = makeLogger();

    const d = new WakeDispatcher({ registry, backend, logger, audit, allowedCommands: ALLOWLIST, debounceMs: 1000 });
    await expect(d.maybeDispatch({ target: "main", messageId: "m1" })).resolves.toBeUndefined();

    expect(sendCalls).toEqual([]);
    const suppressed = entries.find((e) => e["type"] === "wake_suppressed")!;
    expect(suppressed["reason"]).toBe("pane_state_unsafe");
    expect(suppressed["currentCommand"]).toBe("<probe_failed>");
    expect(registry.getWakeState("main").wakesSuppressed).toBe(1);
    expect(warnings.some((w) => w.message.includes("probe threw"))).toBe(true);
  });
});

describe("WakeDispatcher: audit.log throws", () => {
  it("swallows audit.log throw; counters still increment; dispatcher does not reject", async () => {
    const registry = await makeRegistry();
    registry.register("main", undefined, "claude-inbox");
    const { backend, sendCalls } = makeBackend();
    const { logger, warnings } = makeLogger();
    const audit = { log: () => { throw new Error("audit sink down"); } };

    const d = new WakeDispatcher({ registry, backend, logger, audit, allowedCommands: ALLOWLIST, debounceMs: 1000 });
    await expect(d.maybeDispatch({ target: "main", messageId: "m1" })).resolves.toBeUndefined();

    expect(sendCalls).toHaveLength(1);
    expect(registry.getWakeState("main").wakesDispatched).toBe(1);
    expect(warnings.some((w) => w.message.includes("audit.log threw"))).toBe(true);
  });
});

describe("WakeDispatcher: failure signal propagation", () => {
  it("populates signal in the failure audit entry when backend error carries signal", async () => {
    const registry = await makeRegistry();
    registry.register("main", undefined, "claude-inbox");
    const { backend } = makeBackend({
      sendKeys: async () => {
        const err = Object.assign(new Error("killed"), { exitCode: null, signal: "SIGKILL" });
        throw err;
      },
    });
    const { audit, entries } = makeAuditor();
    const { logger } = makeLogger();

    const d = new WakeDispatcher({ registry, backend, logger, audit, allowedCommands: ALLOWLIST, debounceMs: 1000 });
    await d.maybeDispatch({ target: "main", messageId: "m1" });

    const dispatched = entries.find((e) => e["type"] === "wake_dispatched")!;
    expect(dispatched["status"]).toBe("failed");
    expect(dispatched["signal"]).toBe("SIGKILL");
    expect(dispatched).not.toHaveProperty("exitCode");
  });

  it("propagates failurePhase into the audit entry when backend marks it", async () => {
    const registry = await makeRegistry();
    registry.register("main", undefined, "claude-inbox");
    const { backend } = makeBackend({
      sendKeys: async () => {
        const err = Object.assign(new Error("enter failed"), {
          exitCode: 1, signal: null, failurePhase: "enter",
        });
        throw err;
      },
    });
    const { audit, entries } = makeAuditor();
    const { logger } = makeLogger();

    const d = new WakeDispatcher({ registry, backend, logger, audit, allowedCommands: ALLOWLIST, debounceMs: 1000 });
    await d.maybeDispatch({ target: "main", messageId: "m1" });

    const dispatched = entries.find((e) => e["type"] === "wake_dispatched")!;
    expect(dispatched["status"]).toBe("failed");
    expect(dispatched["failurePhase"]).toBe("enter");
  });
});

describe("WakeDispatcher: currentCommand scrubbing", () => {
  it("strips non-printable bytes from currentCommand in the audit entry", async () => {
    const registry = await makeRegistry();
    registry.register("main", undefined, "claude-inbox");
    const { backend } = makeBackend({
      isPaneStateSafe: async () => ({ safe: false, currentCommand: "evil\x1b[31mprompt\x00" }),
    });
    const { audit, entries } = makeAuditor();
    const { logger } = makeLogger();

    const d = new WakeDispatcher({ registry, backend, logger, audit, allowedCommands: ALLOWLIST, debounceMs: 1000 });
    await d.maybeDispatch({ target: "main", messageId: "m1" });

    const suppressed = entries.find((e) => e["type"] === "wake_suppressed")!;
    const current = suppressed["currentCommand"] as string;
    expect(current).not.toContain("\x1b");
    expect(current).not.toContain("\x00");
    expect(current).toContain("evil");
    expect(current).toContain("prompt");
  });

  it("truncates a ludicrously long currentCommand", async () => {
    const registry = await makeRegistry();
    registry.register("main", undefined, "claude-inbox");
    const long = "a".repeat(1000);
    const { backend } = makeBackend({
      isPaneStateSafe: async () => ({ safe: false, currentCommand: long }),
    });
    const { audit, entries } = makeAuditor();
    const { logger } = makeLogger();

    const d = new WakeDispatcher({ registry, backend, logger, audit, allowedCommands: ALLOWLIST, debounceMs: 1000 });
    await d.maybeDispatch({ target: "main", messageId: "m1" });

    const suppressed = entries.find((e) => e["type"] === "wake_suppressed")!;
    expect((suppressed["currentCommand"] as string).length).toBeLessThanOrEqual(128);
  });
});

describe("WakeDispatcher: debounceMs: 0", () => {
  it("never suppresses when debounceMs is 0 (every call dispatches)", async () => {
    const registry = await makeRegistry();
    registry.register("main", undefined, "claude-inbox");
    const { backend, sendCalls } = makeBackend();
    const { audit } = makeAuditor();
    const { logger } = makeLogger();

    const d = new WakeDispatcher({ registry, backend, logger, audit, allowedCommands: ALLOWLIST, debounceMs: 0 });
    for (let i = 0; i < 3; i++) await d.maybeDispatch({ target: "main", messageId: `m${i}` });

    expect(sendCalls).toHaveLength(3);
  });
});

describe("WakeDispatcher: audit content restrictions", () => {
  it("never leaks resolved command string, tokens, or tokenHash", async () => {
    const registry = await makeRegistry();
    const result = registry.register("main", undefined, "claude-inbox");
    const { backend } = makeBackend();
    const { audit, entries } = makeAuditor();
    const { logger } = makeLogger();

    const d = new WakeDispatcher({ registry, backend, logger, audit, allowedCommands: ALLOWLIST, debounceMs: 1000 });
    await d.maybeDispatch({ target: "main", messageId: "m1" });
    await d.maybeDispatch({ target: "main", messageId: "m2" }); // will be debounced

    for (const entry of entries) {
      const json = JSON.stringify(entry);
      expect(json).not.toContain("/opsx:peer-inbox");
      expect(json).not.toContain(result.rawToken);
      expect(json).not.toContain(result.entry.tokenHash);
    }
  });
});
