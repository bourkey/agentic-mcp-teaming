import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import {
  SessionRegistry,
  RegistryError,
  PEER_BUS_MAX_UNREAD,
} from "../src/core/session-registry.js";
import type { Logger } from "../src/core/logger.js";
import type { PeerMessage } from "../src/core/message-store.js";

function makeLogger(): { logger: Logger; errors: Array<{ message: string; meta: Record<string, unknown> | undefined }>; warnings: Array<{ message: string; meta: Record<string, unknown> | undefined }> } {
  const errors: Array<{ message: string; meta: Record<string, unknown> | undefined }> = [];
  const warnings: Array<{ message: string; meta: Record<string, unknown> | undefined }> = [];
  const logger: Logger = {
    info: () => {},
    warn: (message, meta) => { warnings.push({ message, meta }); },
    error: (message, meta) => { errors.push({ message, meta }); },
  };
  return { logger, errors, warnings };
}

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "session-registry-test-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("SessionRegistry.register", () => {
  it("creates a fresh entry and returns token", () => {
    const { logger } = makeLogger();
    const r = new SessionRegistry(join(dir, "r.json"), logger);
    const { entry, rawToken } = r.register("frontend");
    expect(entry.name).toBe("frontend");
    expect(entry.unreadMessageIds).toEqual([]);
    expect(entry.tokenHash).toMatch(/^[a-f0-9]{64}$/);
    expect(rawToken.length).toBeGreaterThan(20);
  });

  it("rejects invalid session names", () => {
    const { logger } = makeLogger();
    const r = new SessionRegistry(join(dir, "r.json"), logger);
    expect(() => r.register("Frontend!")).toThrow(RegistryError);
    expect(() => r.register("")).toThrow(RegistryError);
    expect(() => r.register("-leading-hyphen")).toThrow(RegistryError);
  });

  it("rejects priorSessionToken on fresh registration", () => {
    const { logger } = makeLogger();
    const r = new SessionRegistry(join(dir, "r.json"), logger);
    expect(() => r.register("frontend", "anything")).toThrow(RegistryError);
  });

  it("rotates token on re-registration with correct priorSessionToken", () => {
    const { logger } = makeLogger();
    const r = new SessionRegistry(join(dir, "r.json"), logger);
    const first = r.register("frontend");
    const second = r.register("frontend", first.rawToken);
    expect(second.rawToken).not.toBe(first.rawToken);
    expect(second.entry.registeredAt).toBe(first.entry.registeredAt);
    // Old token should no longer authenticate
    expect(r.authenticate(first.rawToken)).toBeNull();
    expect(r.authenticate(second.rawToken)?.name).toBe("frontend");
  });

  it("rejects re-registration without priorSessionToken on active name", () => {
    const { logger } = makeLogger();
    const r = new SessionRegistry(join(dir, "r.json"), logger);
    r.register("frontend");
    try {
      r.register("frontend");
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(RegistryError);
      expect((err as RegistryError).code).toBe("invalid_prior_session_token_required");
    }
  });

  it("rejects re-registration with wrong priorSessionToken", () => {
    const { logger } = makeLogger();
    const r = new SessionRegistry(join(dir, "r.json"), logger);
    r.register("frontend");
    try {
      r.register("frontend", "wrongtoken");
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(RegistryError);
      expect((err as RegistryError).code).toBe("invalid_prior_session_token_required");
    }
  });

  it("accepts re-registration without priorSessionToken on empty-tokenHash entry", () => {
    const { logger } = makeLogger();
    const r = new SessionRegistry(join(dir, "r.json"), logger);
    r.register("frontend");
    r.clearTokenHashes();
    const second = r.register("frontend");
    expect(second.entry.tokenHash).not.toBe("");
  });
});

describe("SessionRegistry.authenticate", () => {
  it("returns matching entry for valid token", () => {
    const { logger } = makeLogger();
    const r = new SessionRegistry(join(dir, "r.json"), logger);
    const { rawToken } = r.register("frontend");
    expect(r.authenticate(rawToken)?.name).toBe("frontend");
  });

  it("returns null for invalid token", () => {
    const { logger } = makeLogger();
    const r = new SessionRegistry(join(dir, "r.json"), logger);
    r.register("frontend");
    expect(r.authenticate("bogus")).toBeNull();
  });

  it("empty-tokenHash entry never matches any presented token", () => {
    const { logger } = makeLogger();
    const r = new SessionRegistry(join(dir, "r.json"), logger);
    const { rawToken } = r.register("frontend");
    r.clearTokenHashes();
    expect(r.authenticate(rawToken)).toBeNull();
    expect(r.authenticate("")).toBeNull();
    expect(r.authenticate("a".repeat(43))).toBeNull();
  });

  it("iterates every entry — match at end is found", () => {
    const { logger } = makeLogger();
    const r = new SessionRegistry(join(dir, "r.json"), logger);
    for (let i = 0; i < 20; i += 1) r.register(`s${i}`);
    const last = r.register("target");
    expect(r.authenticate(last.rawToken)?.name).toBe("target");
  });
});

describe("SessionRegistry.addUnread and drainUnread", () => {
  const nowIso = () => new Date().toISOString();

  function mkMsg(id: string, to: string, body: string, at?: number): PeerMessage {
    const ts = at !== undefined ? new Date(at).toISOString() : nowIso();
    return { messageId: id, from: "a", to, kind: "chat", body, timestamp: ts };
  }

  it("addUnread returns true up to cap, false beyond", () => {
    const { logger } = makeLogger();
    const r = new SessionRegistry(join(dir, "r.json"), logger);
    r.register("frontend");
    for (let i = 0; i < PEER_BUS_MAX_UNREAD; i += 1) {
      expect(r.addUnread("frontend", `m${i}`)).toBe(true);
    }
    expect(r.addUnread("frontend", "overflow")).toBe(false);
  });

  it("drainUnread drains to maxBytes and returns hasMore", () => {
    const { logger } = makeLogger();
    const r = new SessionRegistry(join(dir, "r.json"), logger);
    r.register("frontend");
    const lookup = new Map<string, PeerMessage>();
    const wrapEnvelope = (m: PeerMessage): string =>
      `<peer-message from="${m.from}" kind="${m.kind}" messageId="${m.messageId}">${m.body as string}</peer-message>`;

    for (let i = 0; i < 20; i += 1) {
      const id = `m${i}`;
      const msg = mkMsg(id, "frontend", "x".repeat(100), 1700000000000 + i);
      lookup.set(id, msg);
      r.addUnread("frontend", id);
    }
    const { messages, hasMore } = r.drainUnread("frontend", lookup, wrapEnvelope, 500);
    expect(messages.length).toBeGreaterThan(0);
    expect(messages.length).toBeLessThan(20);
    expect(hasMore).toBe(true);
    expect(r.get("frontend")?.unreadMessageIds.length).toBe(20 - messages.length);
  });

  it("drainUnread empties mailbox when all fit", () => {
    const { logger } = makeLogger();
    const r = new SessionRegistry(join(dir, "r.json"), logger);
    r.register("frontend");
    const lookup = new Map<string, PeerMessage>();
    const wrapEnvelope = (m: PeerMessage): string => `[${m.messageId}]`;
    for (let i = 0; i < 3; i += 1) {
      const id = `m${i}`;
      lookup.set(id, mkMsg(id, "frontend", "x", 1700000000000 + i));
      r.addUnread("frontend", id);
    }
    const { messages, hasMore } = r.drainUnread("frontend", lookup, wrapEnvelope);
    expect(messages.length).toBe(3);
    expect(hasMore).toBe(false);
    expect(r.get("frontend")?.unreadMessageIds).toEqual([]);
  });

  it("drainUnread returns empty for non-existent session", () => {
    const { logger } = makeLogger();
    const r = new SessionRegistry(join(dir, "r.json"), logger);
    const { messages, hasMore } = r.drainUnread("nobody", new Map(), () => "");
    expect(messages).toEqual([]);
    expect(hasMore).toBe(false);
  });

  it("drainUnread sorts by timestamp ascending", () => {
    const { logger } = makeLogger();
    const r = new SessionRegistry(join(dir, "r.json"), logger);
    r.register("frontend");
    const lookup = new Map<string, PeerMessage>();
    const wrapEnvelope = (m: PeerMessage): string => `[${m.messageId}]`;
    // Add out of order
    const msgs = [
      { id: "late", at: 1700000000300 },
      { id: "early", at: 1700000000100 },
      { id: "mid", at: 1700000000200 },
    ];
    for (const { id, at } of msgs) {
      lookup.set(id, mkMsg(id, "frontend", "x", at));
      r.addUnread("frontend", id);
    }
    const { messages } = r.drainUnread("frontend", lookup, wrapEnvelope);
    expect(messages.map((m) => m.messageId)).toEqual(["early", "mid", "late"]);
  });
});

describe("SessionRegistry.withLock and withLocks", () => {
  it("serialises concurrent calls for the same name", async () => {
    const { logger } = makeLogger();
    const r = new SessionRegistry(join(dir, "r.json"), logger);
    const order: number[] = [];
    const p1 = r.withLock("a", async () => { await new Promise((res) => setTimeout(res, 10)); order.push(1); });
    const p2 = r.withLock("a", async () => { order.push(2); });
    await Promise.all([p1, p2]);
    expect(order).toEqual([1, 2]);
  });

  it("allows parallel different-name locks", async () => {
    const { logger } = makeLogger();
    const r = new SessionRegistry(join(dir, "r.json"), logger);
    let bStarted = false;
    let aFinished = false;
    const pA = r.withLock("a", async () => {
      // Wait long enough that b would start if truly parallel
      await new Promise((res) => setTimeout(res, 30));
      aFinished = true;
    });
    const pB = r.withLock("b", async () => { bStarted = true; });
    await Promise.all([pA, pB]);
    expect(bStarted).toBe(true);
    expect(aFinished).toBe(true);
  });

  it("withLocks sorts lexicographically (no deadlock on inverted ordering)", async () => {
    const { logger } = makeLogger();
    const r = new SessionRegistry(join(dir, "r.json"), logger);
    const pA = r.withLocks("zeta", "alpha", async () => {
      await new Promise((res) => setTimeout(res, 5));
    });
    const pB = r.withLocks("alpha", "zeta", async () => {
      await new Promise((res) => setTimeout(res, 5));
    });
    await Promise.all([pA, pB]);
    expect(true).toBe(true);
  });
});

describe("SessionRegistry persistence", () => {
  it("persist then load round-trips, wiping tokenHash", async () => {
    const { logger } = makeLogger();
    const path = join(dir, "r.json");
    const r1 = new SessionRegistry(path, logger);
    const { rawToken } = r1.register("frontend");
    r1.addUnread("frontend", "m1");
    r1.addUnread("frontend", "m2");
    await r1.persist();

    const r2 = new SessionRegistry(path, logger);
    await r2.load();
    const entry = r2.get("frontend");
    expect(entry).toBeDefined();
    expect(entry!.tokenHash).toBe("");
    expect(entry!.unreadMessageIds).toEqual(["m1", "m2"]);
    expect(r2.authenticate(rawToken)).toBeNull();
  });

  it("load skips entries with invalid session names (including __proto__)", async () => {
    const { logger, errors } = makeLogger();
    const path = join(dir, "r.json");
    // Write raw JSON so __proto__ survives as an own property after parse
    const rawJson = '{"version":1,"sessions":{'
      + '"valid-name":{"name":"valid-name","tokenHash":"","registeredAt":"x","lastSeenAt":"x","unreadMessageIds":[]},'
      + '"Bad Name!":{"name":"Bad Name!","tokenHash":"","registeredAt":"x","lastSeenAt":"x","unreadMessageIds":[]},'
      + '"__proto__":{"polluted":true}'
      + '}}';
    await writeFile(path, rawJson, "utf8");

    const r = new SessionRegistry(path, logger);
    await r.load();
    expect(r.get("valid-name")).toBeDefined();
    expect(r.get("Bad Name!")).toBeUndefined();
    expect(r.get("__proto__")).toBeUndefined();
    expect(errors.length).toBeGreaterThanOrEqual(2);
    // prototype pollution resistance: Object.prototype must not have 'polluted'
    expect(({} as Record<string, unknown>)["polluted"]).toBeUndefined();
  });

  it("load returns gracefully when file does not exist", async () => {
    const { logger } = makeLogger();
    const r = new SessionRegistry(join(dir, "does-not-exist.json"), logger);
    await r.load();
    expect(r.listNames()).toEqual([]);
  });

  it("load tolerates malformed JSON", async () => {
    const { logger, errors } = makeLogger();
    const path = join(dir, "r.json");
    await writeFile(path, "{ broken", "utf8");
    const r = new SessionRegistry(path, logger);
    await r.load();
    expect(errors.length).toBeGreaterThan(0);
    expect(r.listNames()).toEqual([]);
  });
});

describe("SessionRegistry.reconcile", () => {
  it("drops orphaned ids (no corresponding message)", () => {
    const { logger } = makeLogger();
    const r = new SessionRegistry(join(dir, "r.json"), logger);
    r.register("frontend");
    r.addUnread("frontend", "orphan");
    const summary = r.reconcile(new Map());
    expect(summary.orphanedCount).toBe(1);
    expect(r.get("frontend")?.unreadMessageIds).toEqual([]);
  });

  it("drops misrouted ids (message.to !== owner)", () => {
    const { logger } = makeLogger();
    const r = new SessionRegistry(join(dir, "r.json"), logger);
    r.register("frontend");
    r.addUnread("frontend", "m1");
    const lookup = new Map<string, PeerMessage>();
    lookup.set("m1", { messageId: "m1", from: "a", to: "backend", kind: "chat", body: "", timestamp: "x" });
    const summary = r.reconcile(lookup);
    expect(summary.misroutedCount).toBe(1);
    expect(r.get("frontend")?.unreadMessageIds).toEqual([]);
  });
});

describe("Snapshot / restore unread", () => {
  it("snapshot captures a copy; restore sets it back", () => {
    const { logger } = makeLogger();
    const r = new SessionRegistry(join(dir, "r.json"), logger);
    r.register("frontend");
    r.addUnread("frontend", "m1");
    r.addUnread("frontend", "m2");
    const snap = r.snapshotUnread("frontend");
    expect(snap).toEqual(["m1", "m2"]);
    // Drain
    r.get("frontend")!.unreadMessageIds = [];
    expect(r.get("frontend")?.unreadMessageIds).toEqual([]);
    r.restoreUnread("frontend", snap!);
    expect(r.get("frontend")?.unreadMessageIds).toEqual(["m1", "m2"]);
  });
});
