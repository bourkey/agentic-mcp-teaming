import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import * as fs from "fs";

vi.mock("fs", async () => {
  const actual = await vi.importActual<typeof import("fs")>("fs");
  return { ...actual };
});
import {
  MessageStore,
  PEER_BUS_MAX_BODY_BYTES,
  PEER_BUS_MAX_RESPONSE_BYTES,
  computeBodyByteLength,
  nowUtcIso,
  type PeerMessage,
} from "../src/core/message-store.js";
import type { Logger } from "../src/core/logger.js";

function makeLogger(): { logger: Logger; warnings: Array<{ message: string; meta: Record<string, unknown> | undefined }> } {
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
  dir = await mkdtemp(join(tmpdir(), "message-store-test-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("MessageStore", () => {
  it("exports constants with expected values", () => {
    expect(PEER_BUS_MAX_BODY_BYTES).toBe(65536);
    expect(PEER_BUS_MAX_RESPONSE_BYTES).toBe(1048576);
  });

  it("nowUtcIso returns a Z-suffixed ISO string", () => {
    expect(nowUtcIso()).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/);
  });

  it("append-then-load round-trip preserves all fields and timestamp", async () => {
    const path = join(dir, "messages.jsonl");
    const { logger } = makeLogger();
    const store = new MessageStore(path, logger);

    const msg: PeerMessage = {
      messageId: "m1",
      from: "a",
      to: "b",
      kind: "chat",
      body: "hi",
      timestamp: nowUtcIso(),
    };
    await store.append(msg);
    store.close();

    const loaded = await new MessageStore(path, logger).loadAll();
    const back = loaded.get("m1");
    expect(back).toBeDefined();
    expect(back).toMatchObject(msg);
    expect(back!.timestamp.endsWith("Z")).toBe(true);
  });

  it("ten appends produce ten fsync calls", async () => {
    const path = join(dir, "messages.jsonl");
    const { logger } = makeLogger();
    const store = new MessageStore(path, logger);

    const spy = vi.spyOn(fs, "fsyncSync");
    try {
      for (let i = 0; i < 10; i += 1) {
        await store.append({
          messageId: `m${i}`,
          from: "a",
          to: "b",
          kind: "chat",
          body: `n${i}`,
          timestamp: nowUtcIso(),
        });
      }
      expect(spy).toHaveBeenCalledTimes(10);
    } finally {
      spy.mockRestore();
      store.close();
    }
  });

  it("malformed line is logged with line number, byte offset, length, preview; parsing continues", async () => {
    const path = join(dir, "messages.jsonl");
    const good1: PeerMessage = {
      messageId: "g1",
      from: "a",
      to: "b",
      kind: "chat",
      body: "ok",
      timestamp: nowUtcIso(),
    };
    const good2: PeerMessage = {
      messageId: "g2",
      from: "a",
      to: "b",
      kind: "chat",
      body: "ok",
      timestamp: nowUtcIso(),
    };

    const content =
      JSON.stringify(good1) + "\n" +
      "{ not valid json\n" +
      JSON.stringify(good2) + "\n";
    await writeFile(path, content, "utf8");

    const { logger, warnings } = makeLogger();
    const loaded = await new MessageStore(path, logger).loadAll();

    expect(loaded.size).toBe(2);
    expect(loaded.has("g1")).toBe(true);
    expect(loaded.has("g2")).toBe(true);
    expect(warnings.length).toBe(1);
    const meta = warnings[0]!.meta!;
    expect(meta["lineNumber"]).toBe(2);
    expect(typeof meta["byteOffset"]).toBe("number");
    expect(typeof meta["lineLength"]).toBe("number");
    expect(typeof meta["preview"]).toBe("string");
  });

  it("empty file loads as empty Map", async () => {
    const path = join(dir, "messages.jsonl");
    await writeFile(path, "", "utf8");
    const { logger } = makeLogger();
    const loaded = await new MessageStore(path, logger).loadAll();
    expect(loaded.size).toBe(0);
  });

  it("missing file loads as empty Map", async () => {
    const path = join(dir, "does-not-exist.jsonl");
    const { logger } = makeLogger();
    const loaded = await new MessageStore(path, logger).loadAll();
    expect(loaded.size).toBe(0);
  });
});

describe("computeBodyByteLength", () => {
  it("measures string bodies", () => {
    expect(computeBodyByteLength("abc")).toBe(3);
    expect(computeBodyByteLength("")).toBe(0);
  });

  it("measures object bodies via compact JSON", () => {
    const body = { event: "worktree-ready", change: "portal-foo" };
    expect(computeBodyByteLength(body)).toBe(Buffer.byteLength(JSON.stringify(body), "utf8"));
  });

  it("boundary: body of exactly 65536 bytes is accepted at the limit", () => {
    const payload = "a".repeat(PEER_BUS_MAX_BODY_BYTES);
    expect(computeBodyByteLength(payload)).toBe(PEER_BUS_MAX_BODY_BYTES);
  });

  it("boundary: body of 65537 bytes exceeds the limit", () => {
    const payload = "a".repeat(PEER_BUS_MAX_BODY_BYTES + 1);
    expect(computeBodyByteLength(payload)).toBe(PEER_BUS_MAX_BODY_BYTES + 1);
  });

  it("measures multi-byte utf8 correctly", () => {
    expect(computeBodyByteLength("€")).toBe(3);
    expect(computeBodyByteLength({ s: "€" })).toBe(Buffer.byteLength('{"s":"€"}', "utf8"));
  });
});
