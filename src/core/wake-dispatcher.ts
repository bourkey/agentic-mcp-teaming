import type { Logger } from "./logger.js";
import type { SessionRegistry } from "./session-registry.js";
import type { WakeBackend, WakeBackendError } from "./wake-backend.js";

const PROBE_FAILED_SENTINEL = "<probe_failed>";
// Audit entries surface `currentCommand` read from the recipient's tmux pane
// (whatever process is running there). Strip anything outside ASCII-printable
// and truncate so a hostile process comm can't poison the audit log.
const CURRENT_COMMAND_MAX = 64;
function scrubCurrentCommand(s: string): string {
  return s.replace(/[^\x20-\x7E]/g, "").slice(0, CURRENT_COMMAND_MAX);
}

export type WakeAuditor = {
  log(entry: Record<string, unknown>): void;
};

export interface WakeDispatcherOptions {
  registry: SessionRegistry;
  backend: WakeBackend;
  logger: Logger;
  audit: WakeAuditor;
  /** Snapshot of `peerBus.autoWake.allowedCommands` at coordinator startup. */
  allowedCommands: Readonly<Record<string, string>>;
  /** Snapshot of `peerBus.autoWake.debounceMs`. */
  debounceMs: number;
}

export interface DispatchWakeInput {
  target: string;
  messageId: string;
}

export type SuppressReason =
  | "debounce"
  | "pane_state_unsafe"
  | "key_no_longer_in_allowlist";

/**
 * Active-injection side of the peer-bus notifier path. Invoked once per
 * `send_message` delivery in parallel with the passive window-bar decoration.
 *
 * Flow for an opted-in recipient (registry entry has `autoWakeKey` set):
 *   1. Resolve `autoWakeKey` against the live allowlist.
 *        Stale key → emit `wake_suppressed { reason: "key_no_longer_in_allowlist" }`, bump counter, done.
 *   2. Probe pane state via backend.
 *        Unsafe → emit `wake_suppressed { reason: "pane_state_unsafe", currentCommand }`, bump counter, done.
 *        (Debounce timestamp NOT updated — pane unsafety is a non-event for the window.)
 *   3. Check-and-set the debounce timestamp through `registry.tryConsumeWakeWindow`
 *      inside the existing per-session mutex. This atomically closes the same-tick race:
 *      a concurrent invocation observing the same recipient within the window sees the
 *      updated timestamp and suppresses. Both successful AND failed backend dispatches
 *      update the timestamp (failures do not retry-spam).
 *        Suppressed → emit `wake_suppressed { reason: "debounce" }`, bump counter, done.
 *   4. Invoke `backend.sendKeys` outside the mutex.
 *        Success → `wake_dispatched { status: "ok" }`, bump wakesDispatched.
 *        Failure → `wake_dispatched { status: "failed", exitCode, signal }` +
 *                  warn log with `{ target, commandKey, exitCode, signal }` (NO resolved string),
 *                  bump wakesFailed. No retry, no propagation to the caller.
 *
 * Recipients without `autoWakeKey` are opted out — `maybeDispatch` is a no-op
 * for them. Caller SHOULD still invoke it unconditionally; gating happens here.
 */
export class WakeDispatcher {
  private readonly opts: WakeDispatcherOptions;

  constructor(opts: WakeDispatcherOptions) {
    this.opts = opts;
  }

  async maybeDispatch(input: DispatchWakeInput): Promise<void> {
    const { registry, backend, logger, audit, allowedCommands, debounceMs } = this.opts;
    const { target, messageId } = input;

    const entry = registry.get(target);
    if (entry === undefined || entry.autoWakeKey === undefined) return;

    const commandKey = entry.autoWakeKey;
    const resolvedCommand = allowedCommands[commandKey];
    const now = Date.now();

    if (resolvedCommand === undefined) {
      this.emitSuppressed(now, target, commandKey, messageId, "key_no_longer_in_allowlist");
      this.safeIncrement(target, "suppressed");
      return;
    }

    // Probe pane state OUTSIDE the mutex — concurrent sends may both probe.
    // Only the first to reach the debounce check-and-set below takes the
    // window. Defensive try/catch so a custom backend that throws from
    // `isPaneStateSafe` (rather than returning `safe: false`) degrades to the
    // same suppression path as a genuine unsafe pane.
    let probe: { safe: boolean; currentCommand: string };
    try {
      probe = await backend.isPaneStateSafe(target);
    } catch (err) {
      logger.warn("wake-dispatcher: pane probe threw", {
        target,
        commandKey,
        error: (err as Error).message,
      });
      probe = { safe: false, currentCommand: PROBE_FAILED_SENTINEL };
    }
    if (!probe.safe) {
      this.emitSuppressed(
        now,
        target,
        commandKey,
        messageId,
        "pane_state_unsafe",
        probe.currentCommand
      );
      this.safeIncrement(target, "suppressed");
      return;
    }

    const tookWindow = await registry.withLock(target, async () => {
      return registry.tryConsumeWakeWindow(target, now, debounceMs);
    });

    if (!tookWindow) {
      this.emitSuppressed(now, target, commandKey, messageId, "debounce");
      this.safeIncrement(target, "suppressed");
      return;
    }

    const dispatchedAt = new Date(now).toISOString();
    try {
      await backend.sendKeys(target, resolvedCommand);
      this.safeAudit({
        type: "wake_dispatched",
        target,
        commandKey,
        messageId,
        dispatchedAt,
        status: "ok",
      });
      this.safeIncrement(target, "dispatched");
    } catch (err) {
      const e = err as WakeBackendError;
      const exitCode = typeof e.exitCode === "number" ? e.exitCode : null;
      const signal = typeof e.signal === "string" ? e.signal : null;
      const failurePhase = e.failurePhase;
      logger.warn("wake-dispatcher: send-keys failed", {
        target,
        commandKey,
        exitCode,
        signal,
        ...(failurePhase !== undefined ? { failurePhase } : {}),
      });
      this.safeAudit({
        type: "wake_dispatched",
        target,
        commandKey,
        messageId,
        dispatchedAt,
        status: "failed",
        ...(exitCode !== null ? { exitCode } : {}),
        ...(signal !== null ? { signal } : {}),
        ...(failurePhase !== undefined ? { failurePhase } : {}),
      });
      this.safeIncrement(target, "failed");
    }
  }

  private emitSuppressed(
    now: number,
    target: string,
    commandKey: string,
    messageId: string,
    reason: SuppressReason,
    currentCommand?: string
  ): void {
    this.safeAudit({
      type: "wake_suppressed",
      target,
      commandKey,
      messageId,
      reason,
      suppressedAt: new Date(now).toISOString(),
      ...(currentCommand !== undefined ? { currentCommand: scrubCurrentCommand(currentCommand) } : {}),
    });
  }

  /**
   * Log an audit entry without letting a faulty audit sink break the
   * dispatcher's counter invariants. If `audit.log` throws, fall back to a
   * warn log and continue — the counter increment that follows in the caller
   * stays in lockstep with "we attempted the dispatch".
   */
  private safeAudit(entry: Record<string, unknown>): void {
    try {
      this.opts.audit.log(entry);
    } catch (err) {
      this.opts.logger.warn("wake-dispatcher: audit.log threw; counter still updated", {
        type: entry["type"],
        error: (err as Error).message,
      });
    }
  }

  private safeIncrement(target: string, which: "dispatched" | "suppressed" | "failed"): void {
    try {
      this.opts.registry.incrementWakeCounter(target, which);
    } catch (err) {
      this.opts.logger.warn("wake-dispatcher: counter increment threw", {
        target,
        which,
        error: (err as Error).message,
      });
    }
  }
}
