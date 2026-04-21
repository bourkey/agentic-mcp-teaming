import * as fs from "fs";
import * as fsp from "fs/promises";
import * as crypto from "crypto";
import type { Logger } from "./logger.js";
import { PEER_BUS_MAX_RESPONSE_BYTES, type PeerMessage } from "./message-store.js";

export const PEER_BUS_MAX_UNREAD = 10000;
export { SESSION_NAME_REGEX } from "./peer-bus-constants.js";
import { SESSION_NAME_REGEX } from "./peer-bus-constants.js";

const ZERO_SENTINEL = Buffer.alloc(32, 0);

export interface SessionEntry {
  name: string;
  tokenHash: string;
  registeredAt: string;
  lastSeenAt: string;
  unreadMessageIds: string[];
}

export interface DrainResult {
  messages: Array<{ messageId: string; wrapped: string }>;
  hasMore: boolean;
}

export interface RegisterResult {
  entry: SessionEntry;
  rawToken: string;
}

export class RegistryError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

function sha256(input: string | Buffer): Buffer {
  return crypto.createHash("sha256").update(input).digest();
}

function sha256Hex(input: string | Buffer): string {
  return sha256(input).toString("hex");
}

function nowIso(): string {
  return new Date().toISOString();
}

export class SessionRegistry {
  private readonly sessions = new Map<string, SessionEntry>();
  private readonly locks = new Map<string, Promise<unknown>>();
  private readonly path: string;
  private readonly logger: Logger;

  constructor(path: string, logger: Logger) {
    this.path = path;
    this.logger = logger;
  }

  has(name: string): boolean {
    return this.sessions.has(name);
  }

  get(name: string): SessionEntry | undefined {
    return this.sessions.get(name);
  }

  listNames(): string[] {
    return Array.from(this.sessions.keys());
  }

  async withLock<T>(name: string, fn: () => Promise<T>): Promise<T> {
    const prior = this.locks.get(name) ?? Promise.resolve();
    let release!: () => void;
    const next = new Promise<void>((r) => { release = r; });
    const chained = prior.then(() => next);
    this.locks.set(name, chained);
    await prior;
    try {
      return await fn();
    } finally {
      release();
    }
  }

  async withLocks<T>(nameA: string, nameB: string, fn: () => Promise<T>): Promise<T> {
    if (nameA === nameB) return this.withLock(nameA, fn);
    const [first, second] = nameA < nameB ? [nameA, nameB] : [nameB, nameA];
    return this.withLock(first, () => this.withLock(second, fn));
  }

  register(name: string, priorSessionToken?: string): RegisterResult {
    if (!SESSION_NAME_REGEX.test(name)) {
      throw new RegistryError("invalid_session_name", `name '${name}' does not match required pattern`);
    }

    const existing = this.sessions.get(name);
    const hasActiveToken = existing !== undefined && existing.tokenHash !== "";

    if (existing === undefined) {
      if (priorSessionToken !== undefined) {
        throw new RegistryError(
          "invalid_prior_session_token_required",
          "fresh registration must not include priorSessionToken"
        );
      }
    } else if (hasActiveToken) {
      if (priorSessionToken === undefined) {
        throw new RegistryError(
          "invalid_prior_session_token_required",
          "re-registration against an active name requires priorSessionToken"
        );
      }
      const presented = sha256(priorSessionToken);
      const stored = Buffer.from(existing.tokenHash, "hex");
      if (presented.length !== stored.length || !crypto.timingSafeEqual(presented, stored)) {
        throw new RegistryError(
          "invalid_prior_session_token_required",
          "priorSessionToken does not match stored tokenHash"
        );
      }
    } else {
      // existing entry with empty tokenHash (post-restart, pre-reregister)
      if (priorSessionToken !== undefined) {
        throw new RegistryError(
          "invalid_prior_session_token_required",
          "loaded-from-disk entry has no active owner; priorSessionToken must not be provided"
        );
      }
    }

    const rawToken = crypto.randomBytes(32).toString("base64url");
    const tokenHash = sha256Hex(rawToken);
    const now = nowIso();

    const entry: SessionEntry =
      existing !== undefined
        ? {
            name,
            tokenHash,
            registeredAt: existing.registeredAt,
            lastSeenAt: now,
            unreadMessageIds: existing.unreadMessageIds,
          }
        : {
            name,
            tokenHash,
            registeredAt: now,
            lastSeenAt: now,
            unreadMessageIds: [],
          };

    this.sessions.set(name, entry);
    return { entry, rawToken };
  }

  authenticate(rawToken: string): SessionEntry | null {
    const presented = sha256(rawToken);
    let matched: SessionEntry | null = null;
    for (const entry of this.sessions.values()) {
      const stored = entry.tokenHash !== "" ? Buffer.from(entry.tokenHash, "hex") : ZERO_SENTINEL;
      // Pad/truncate to 32 bytes for uniform comparison cost
      const compareTarget = stored.length === 32 ? stored : ZERO_SENTINEL;
      const isMatch = crypto.timingSafeEqual(presented, compareTarget);
      if (isMatch && entry.tokenHash !== "") {
        matched = entry;
      }
    }
    return matched;
  }

  touch(name: string): void {
    const entry = this.sessions.get(name);
    if (entry !== undefined) entry.lastSeenAt = nowIso();
  }

  addUnread(name: string, messageId: string): boolean {
    const entry = this.sessions.get(name);
    if (entry === undefined) return false;
    if (entry.unreadMessageIds.length >= PEER_BUS_MAX_UNREAD) return false;
    entry.unreadMessageIds.push(messageId);
    return true;
  }

  canAddUnread(name: string): boolean {
    const entry = this.sessions.get(name);
    if (entry === undefined) return false;
    return entry.unreadMessageIds.length < PEER_BUS_MAX_UNREAD;
  }

  snapshotEntry(name: string): SessionEntry | undefined {
    const entry = this.sessions.get(name);
    if (entry === undefined) return undefined;
    return {
      name: entry.name,
      tokenHash: entry.tokenHash,
      registeredAt: entry.registeredAt,
      lastSeenAt: entry.lastSeenAt,
      unreadMessageIds: [...entry.unreadMessageIds],
    };
  }

  restoreEntry(name: string, snapshot: SessionEntry | undefined): void {
    if (snapshot === undefined) {
      this.sessions.delete(name);
    } else {
      this.sessions.set(name, {
        name: snapshot.name,
        tokenHash: snapshot.tokenHash,
        registeredAt: snapshot.registeredAt,
        lastSeenAt: snapshot.lastSeenAt,
        unreadMessageIds: [...snapshot.unreadMessageIds],
      });
    }
  }

  /**
   * Drain up to PEER_BUS_MAX_RESPONSE_BYTES of wrapped envelopes for the caller.
   * Returns the drained messages and whether more remain in the unread list.
   * Atomically removes drained ids from the session's unreadMessageIds.
   * If the caller wants a rollback (e.g. on persist failure), it should snapshot
   * unreadMessageIds before calling drainUnread and restore on failure.
   */
  drainUnread(
    name: string,
    messageLookup: Map<string, PeerMessage>,
    wrapEnvelope: (msg: PeerMessage) => string,
    maxBytes: number = PEER_BUS_MAX_RESPONSE_BYTES
  ): DrainResult {
    const entry = this.sessions.get(name);
    if (entry === undefined) return { messages: [], hasMore: false };

    // Build timestamp-sorted candidates while preserving append order as tiebreak
    const candidates: Array<{ idx: number; msg: PeerMessage; id: string }> = [];
    for (let i = 0; i < entry.unreadMessageIds.length; i += 1) {
      const id = entry.unreadMessageIds[i]!;
      const msg = messageLookup.get(id);
      if (msg !== undefined) candidates.push({ idx: i, msg, id });
    }
    candidates.sort((a, b) => {
      const ta = Date.parse(a.msg.timestamp);
      const tb = Date.parse(b.msg.timestamp);
      if (ta !== tb) return ta - tb;
      return a.idx - b.idx;
    });

    const drained: Array<{ messageId: string; wrapped: string }> = [];
    const drainedIdSet = new Set<string>();
    let cumulative = 0;
    let stoppedEarly = false;
    for (const { msg, id } of candidates) {
      const wrapped = wrapEnvelope(msg);
      const size = Buffer.byteLength(wrapped, "utf8");
      if (drained.length > 0 && cumulative + size > maxBytes) {
        stoppedEarly = true;
        break;
      }
      drained.push({ messageId: id, wrapped });
      drainedIdSet.add(id);
      cumulative += size;
      if (cumulative > maxBytes) {
        // single oversize message: included, but stop here
        stoppedEarly = true;
        break;
      }
    }

    // Also drop orphan ids (present in unread but not in messageLookup) so they
    // don't accumulate mid-session. Startup reconciliation catches this too,
    // but a long-running coordinator with torn writes would otherwise pin the
    // slot forever.
    const orphanIds = new Set<string>();
    for (const id of entry.unreadMessageIds) {
      if (!drainedIdSet.has(id) && !messageLookup.has(id)) {
        orphanIds.add(id);
      }
    }
    if (orphanIds.size > 0) {
      this.logger.warn("registry: drainUnread dropping orphan ids", {
        name,
        count: orphanIds.size,
      });
    }

    entry.unreadMessageIds = entry.unreadMessageIds.filter(
      (id) => !drainedIdSet.has(id) && !orphanIds.has(id)
    );
    const hasMore = stoppedEarly && entry.unreadMessageIds.length > 0;
    return { messages: drained, hasMore };
  }

  /**
   * Snapshot a session's unreadMessageIds for rollback support.
   */
  snapshotUnread(name: string): string[] | null {
    const entry = this.sessions.get(name);
    return entry === undefined ? null : [...entry.unreadMessageIds];
  }

  /**
   * Restore the unreadMessageIds of a session from a prior snapshot.
   */
  restoreUnread(name: string, snapshot: string[]): void {
    const entry = this.sessions.get(name);
    if (entry !== undefined) entry.unreadMessageIds = [...snapshot];
  }

  clearTokenHashes(): void {
    for (const entry of this.sessions.values()) entry.tokenHash = "";
  }

  async persist(): Promise<void> {
    const serialised: Record<string, SessionEntry> = {};
    for (const [key, value] of this.sessions.entries()) serialised[key] = value;
    const payload = { version: 1, sessions: serialised };
    const tmp = this.path + ".tmp";
    await fsp.writeFile(tmp, JSON.stringify(payload, null, 2), { encoding: "utf8", mode: 0o600 });
    await fsp.rename(tmp, this.path);
  }

  async load(): Promise<void> {
    if (!fs.existsSync(this.path)) return;
    const raw = await fsp.readFile(this.path, "utf8");
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      this.logger.error("registry: failed to parse registry.json", { error: (err as Error).message });
      return;
    }
    if (typeof parsed !== "object" || parsed === null) return;
    const obj = parsed as { sessions?: unknown };
    if (typeof obj.sessions !== "object" || obj.sessions === null) return;

    this.sessions.clear();
    const sessionsObj = obj.sessions as Record<string, unknown>;
    for (const key of Object.keys(sessionsObj)) {
      if (!SESSION_NAME_REGEX.test(key)) {
        this.logger.error("registry: skipping invalid session name", {
          name: JSON.stringify(key),
        });
        continue;
      }
      const entryRaw = sessionsObj[key];
      if (typeof entryRaw !== "object" || entryRaw === null) continue;
      const e = entryRaw as Partial<SessionEntry>;
      if (
        typeof e.name !== "string" ||
        typeof e.registeredAt !== "string" ||
        typeof e.lastSeenAt !== "string" ||
        !Array.isArray(e.unreadMessageIds)
      ) continue;
      const cleaned: SessionEntry = {
        name: e.name,
        tokenHash: "", // wipe on load
        registeredAt: e.registeredAt,
        lastSeenAt: e.lastSeenAt,
        unreadMessageIds: e.unreadMessageIds.filter((x): x is string => typeof x === "string"),
      };
      this.sessions.set(key, cleaned);
    }
  }

  reconcile(
    messageLookup: Map<string, PeerMessage>
  ): { orphanedCount: number; misroutedCount: number; firstFewIds: string[] } {
    let orphanedCount = 0;
    let misroutedCount = 0;
    const firstFewIds: string[] = [];
    for (const entry of this.sessions.values()) {
      entry.unreadMessageIds = entry.unreadMessageIds.filter((id) => {
        const msg = messageLookup.get(id);
        if (msg === undefined) {
          orphanedCount += 1;
          if (firstFewIds.length < 5) firstFewIds.push(id);
          return false;
        }
        if (msg.to !== entry.name) {
          misroutedCount += 1;
          if (firstFewIds.length < 5) firstFewIds.push(id);
          return false;
        }
        return true;
      });
    }
    if (orphanedCount > 0 || misroutedCount > 0) {
      this.logger.warn("registry: reconciliation dropped unread ids", {
        orphanedCount,
        misroutedCount,
        firstFewIds,
      });
    }
    return { orphanedCount, misroutedCount, firstFewIds };
  }
}
