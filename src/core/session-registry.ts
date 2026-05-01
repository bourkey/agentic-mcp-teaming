import * as fs from "fs";
import * as fsp from "fs/promises";
import * as crypto from "crypto";
import type { Logger } from "./logger.js";
import { PEER_BUS_MAX_RESPONSE_BYTES, type PeerMessage } from "./message-store.js";

export const PEER_BUS_MAX_UNREAD = 10000;
export { SESSION_NAME_REGEX } from "./peer-bus-constants.js";
import { SESSION_NAME_REGEX, PEER_BUS_SESSION_DEFAULT_TTL_MS } from "./peer-bus-constants.js";

const ZERO_SENTINEL = Buffer.alloc(32, 0);

export interface SessionEntry {
  name: string;
  tokenHash: string;
  /** sha256(paneToken) — persists across coordinator restarts, never wiped by clearTokenHashes() */
  paneTokenHash?: string;
  registeredAt: string;
  lastSeenAt: string;
  unreadMessageIds: string[];
  /** Opt-in allowlist key for auto-wake dispatch. Persisted to registry.json. */
  autoWakeKey?: string;
}

export interface DrainResult {
  messages: Array<{ messageId: string; wrapped: string }>;
  hasMore: boolean;
}

export interface RegisterResult {
  entry: SessionEntry;
  rawToken: string;
}

/**
 * Per-session wake state held in-memory only. Never persisted to registry.json;
 * resets to defaults on coordinator restart. Key is the session name.
 */
export interface WakeState {
  lastDispatchedAt?: number;
  wakesDispatched: number;
  wakesSuppressed: number;
  wakesFailed: number;
}

function freshWakeState(): WakeState {
  return { wakesDispatched: 0, wakesSuppressed: 0, wakesFailed: 0 };
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
  private readonly wakeStates = new Map<string, WakeState>();
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

  register(
    name: string,
    paneToken: string,
    autoWakeKey?: string | null,
    inactivityTtlMs = PEER_BUS_SESSION_DEFAULT_TTL_MS
  ): RegisterResult {
    if (!SESSION_NAME_REGEX.test(name)) {
      throw new RegistryError("invalid_session_name", `name '${name}' does not match required pattern`);
    }

    // Always compute presented hash for timing-safe comparison (prevents oracle attacks)
    const presentedHash = sha256(paneToken);

    const existing = this.sessions.get(name);
    // Whether to preserve registeredAt and unreadMessageIds from the existing entry.
    // true for cases 2 (hash match) and 3 (legacy unowned); false for cases 1 and 5.
    let preserveExisting = false;

    if (existing !== undefined) {
      if (existing.paneTokenHash !== undefined) {
        const stored = Buffer.from(existing.paneTokenHash, "hex");
        const compareTarget = stored.length === 32 ? stored : ZERO_SENTINEL;
        const hashMatch = crypto.timingSafeEqual(presentedHash, compareTarget);

        if (hashMatch) {
          // Case 2: hash matches — re-registration always succeeds, preserve identity
          preserveExisting = true;
        } else {
          // Hash mismatch — check TTL (TTL=0 disables eviction entirely)
          // Treat malformed lastSeenAt (NaN from Date.parse) as within-TTL to
          // prevent eviction via a poisoned registry.json entry.
          const lastSeen = Date.parse(existing.lastSeenAt);
          const age = Number.isNaN(lastSeen) ? 0 : Date.now() - lastSeen;
          const withinTtl = inactivityTtlMs === 0 || age < inactivityTtlMs;
          if (withinTtl) {
            // Case 4: live entry owned by someone else — reject
            throw new RegistryError("invalid_pane_token", "paneToken does not match the registered credential for this session name");
          }
          // Case 5: stale entry — evict; log contains only name and timestamp, never token values
          this.logger.warn("register: evicting stale session", {
            name: existing.name,
            lastSeenAt: existing.lastSeenAt,
          });
          preserveExisting = false;
        }
      } else {
        // Case 3: legacy entry (no paneTokenHash) — treat as unowned, preserve identity
        preserveExisting = true;
      }
    }
    // Case 1: no existing entry — preserveExisting stays false

    const rawToken = crypto.randomBytes(32).toString("base64url");
    const tokenHash = sha256Hex(rawToken);
    const paneTokenHash = presentedHash.toString("hex");
    const now = nowIso();

    // autoWakeKey semantics:
    //   undefined → preserve existing (on re-register) or leave unset (on fresh)
    //   null      → clear
    //   string    → set (validation is handler-side, not here)
    let resolvedAutoWakeKey: string | undefined;
    if (autoWakeKey === null) {
      resolvedAutoWakeKey = undefined;
    } else if (autoWakeKey === undefined) {
      resolvedAutoWakeKey = preserveExisting ? existing?.autoWakeKey : undefined;
    } else {
      resolvedAutoWakeKey = autoWakeKey;
    }

    const entry: SessionEntry =
      preserveExisting && existing !== undefined
        ? {
            name,
            tokenHash,
            paneTokenHash,
            registeredAt: existing.registeredAt,
            lastSeenAt: now,
            unreadMessageIds: existing.unreadMessageIds,
            ...(resolvedAutoWakeKey !== undefined ? { autoWakeKey: resolvedAutoWakeKey } : {}),
          }
        : {
            name,
            tokenHash,
            paneTokenHash,
            registeredAt: now,
            lastSeenAt: now,
            unreadMessageIds: [],
            ...(resolvedAutoWakeKey !== undefined ? { autoWakeKey: resolvedAutoWakeKey } : {}),
          };

    this.sessions.set(name, entry);

    // Re-registration resets the wake state (fresh debounce window, counters at
    // zero) because a new bearer of the session name should not inherit the
    // previous bearer's cadence. Fresh registrations also start at zero.
    this.wakeStates.set(name, freshWakeState());

    return { entry, rawToken };
  }

  authenticate(rawToken: string): SessionEntry | null {
    const presented = sha256(rawToken);
    let matched: SessionEntry | null = null;
    for (const entry of this.sessions.values()) {
      const isEmpty = entry.tokenHash === "";
      const stored = isEmpty ? ZERO_SENTINEL : Buffer.from(entry.tokenHash, "hex");
      const compareTarget = stored.length === 32 ? stored : ZERO_SENTINEL;
      const isMatch = crypto.timingSafeEqual(presented, compareTarget);
      // isEmpty guard is load-bearing: a zero-sentinel collision would otherwise
      // match an empty-hash entry and grant authentication without a valid token.
      if (isMatch && !isEmpty) {
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
      ...(entry.paneTokenHash !== undefined ? { paneTokenHash: entry.paneTokenHash } : {}),
      registeredAt: entry.registeredAt,
      lastSeenAt: entry.lastSeenAt,
      unreadMessageIds: [...entry.unreadMessageIds],
      ...(entry.autoWakeKey !== undefined ? { autoWakeKey: entry.autoWakeKey } : {}),
    };
  }

  restoreEntry(name: string, snapshot: SessionEntry | undefined): void {
    if (snapshot === undefined) {
      this.sessions.delete(name);
      this.wakeStates.delete(name);
    } else {
      this.sessions.set(name, {
        name: snapshot.name,
        tokenHash: snapshot.tokenHash,
        ...(snapshot.paneTokenHash !== undefined ? { paneTokenHash: snapshot.paneTokenHash } : {}),
        registeredAt: snapshot.registeredAt,
        lastSeenAt: snapshot.lastSeenAt,
        unreadMessageIds: [...snapshot.unreadMessageIds],
        ...(snapshot.autoWakeKey !== undefined ? { autoWakeKey: snapshot.autoWakeKey } : {}),
      });
      // wakeStates is in-memory only — leave it intact when restoring a prior entry snapshot
      // so the debounce window is not reset for a session that remains live.
    }
  }

  /**
   * Read the per-session wake state. Returns a fresh zero-initialised entry if
   * the session has no runtime state yet (e.g. freshly loaded from disk and
   * never touched). Intended for the wakeDispatcher; not used by the bus itself.
   */
  getWakeState(name: string): WakeState {
    let state = this.wakeStates.get(name);
    if (state === undefined) {
      state = freshWakeState();
      this.wakeStates.set(name, state);
    }
    return state;
  }

  /**
   * Atomic check-and-set for the per-recipient debounce window. MUST be called
   * inside `withLock(name)` by the caller — no internal locking. Returns true
   * if the caller should proceed with a wake dispatch (and has "taken" the
   * window by setting `lastDispatchedAt` to `now`); false if suppressed.
   *
   * Writing the timestamp BEFORE the async dispatch starts closes the
   * same-tick race: a concurrent invocation inside the same mutex window will
   * observe the updated timestamp and suppress.
   */
  tryConsumeWakeWindow(name: string, now: number, debounceMs: number): boolean {
    const state = this.getWakeState(name);
    if (state.lastDispatchedAt !== undefined && now - state.lastDispatchedAt < debounceMs) {
      return false;
    }
    state.lastDispatchedAt = now;
    return true;
  }

  incrementWakeCounter(name: string, which: "dispatched" | "suppressed" | "failed"): void {
    const state = this.getWakeState(name);
    if (which === "dispatched") state.wakesDispatched += 1;
    else if (which === "suppressed") state.wakesSuppressed += 1;
    else state.wakesFailed += 1;
  }

  /**
   * Revalidate every persisted `autoWakeKey` against a currently-loaded
   * allowlist. Called once at startup after `load()`, with the allowlist keys
   * from `peerBus.autoWake.allowedCommands` (or `null` if auto-wake is
   * disabled coordinator-wide). Returns the list of entries whose stored key
   * was removed so the caller can log a startup warn.
   *
   * Does NOT persist the cleared entries back to disk; the next persist() in
   * the normal course of operation will do that. Keeping the load path
   * read-only is deliberate — registry.json is rewritten often enough that
   * stale keys will naturally clear within a session.
   */
  revalidateAutoWakeKeys(allowlist: Set<string> | null): Array<{ name: string; removedKey: string }> {
    const cleared: Array<{ name: string; removedKey: string }> = [];
    for (const entry of this.sessions.values()) {
      if (entry.autoWakeKey === undefined) continue;
      if (allowlist === null || !allowlist.has(entry.autoWakeKey)) {
        cleared.push({ name: entry.name, removedKey: entry.autoWakeKey });
        delete entry.autoWakeKey;
      }
    }
    return cleared;
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
    // Only wipe the rotating sessionToken hash; paneTokenHash persists across restarts
    for (const entry of this.sessions.values()) entry.tokenHash = "";
  }

  async persist(): Promise<void> {
    const serialised: Record<string, SessionEntry> = {};
    for (const [key, value] of this.sessions.entries()) serialised[key] = value;
    const payload = { version: 1, sessions: serialised };
    const tmp = this.path + ".tmp";
    await fsp.writeFile(tmp, JSON.stringify(payload, null, 2), { encoding: "utf8", mode: 0o600 });
    await fsp.rename(tmp, this.path);
    await fsp.chmod(this.path, 0o600);
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
      if (e.name !== key) {
        this.logger.error("registry: name/key mismatch, skipping", { key, name: e.name });
        continue;
      }
      const cleaned: SessionEntry = {
        name: e.name,
        tokenHash: "", // wipe rotating token on load
        // paneTokenHash persists across restarts — entries without it are legacy unowned
        ...(typeof e.paneTokenHash === "string" && e.paneTokenHash.length > 0
          ? { paneTokenHash: e.paneTokenHash }
          : {}),
        registeredAt: e.registeredAt,
        lastSeenAt: e.lastSeenAt,
        unreadMessageIds: e.unreadMessageIds.filter((x): x is string => typeof x === "string"),
        ...(typeof e.autoWakeKey === "string" && e.autoWakeKey.length > 0
          ? { autoWakeKey: e.autoWakeKey }
          : {}),
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
