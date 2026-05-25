import { execFile } from "child_process";
import { promisify } from "util";
import { PROBE_DISABLED_SENTINEL } from "../peer-bus-constants.js";
import type { WakeBackend, WakeBackendError } from "../wake-backend.js";

const execFileAsync = promisify(execFile);

const CMUX_SURFACE_ID_REGEX = /^surface:\d+$/;
const WAKE_CMUX_TIMEOUT_MS = 5000;

export interface CmuxWakeBackendOptions {
  /** No configuration needed for v1 — options reserved for future use. */
}

/**
 * cmux implementation of WakeBackend. Uses only `execFile` (never `exec`,
 * never `spawn { shell: true }`) with arguments passed as arrays.
 *
 * `isPaneStateSafe` is permanently disabled pending cmux exposing a
 * pane_current_command equivalent (upstream issues #152/#153). It always
 * returns `{ safe: false, suppressReason: "probe_disabled" }` so the
 * dispatcher emits `wake_suppressed { reason: "probe_disabled" }` rather
 * than the generic `pane_state_unsafe`. This makes the disabled probe
 * distinguishable in the audit log.
 *
 * `sendKeys` uses two sequential `execFile` calls:
 *   1. `cmux send-surface --surface <id> <command>` — text injection
 *   2. `cmux send-key-surface --surface <id> enter` — Enter key press
 */
export class CmuxWakeBackend implements WakeBackend {
  constructor(_opts: CmuxWakeBackendOptions = {}) {}

  async isPaneStateSafe(_target: string): Promise<{
    safe: boolean;
    currentCommand: string;
    suppressReason: "probe_disabled";
  }> {
    return { safe: false, currentCommand: PROBE_DISABLED_SENTINEL, suppressReason: "probe_disabled" };
  }

  async sendKeys(target: string, resolvedCommand: string): Promise<void> {
    if (!CMUX_SURFACE_ID_REGEX.test(target)) {
      throw asWakeBackendError(new Error(`invalid cmux target: ${JSON.stringify(target)}`));
    }
    if (resolvedCommand.trim().length === 0) {
      throw asWakeBackendError(new Error("resolvedCommand must be non-empty"));
    }
    try {
      await execFileAsync(
        "cmux",
        ["send-surface", "--surface", target, resolvedCommand],
        { timeout: WAKE_CMUX_TIMEOUT_MS }
      );
    } catch (err) {
      throw asWakeBackendError(err, "type");
    }
    try {
      await execFileAsync(
        "cmux",
        ["send-key-surface", "--surface", target, "enter"],
        { timeout: WAKE_CMUX_TIMEOUT_MS }
      );
    } catch (err) {
      throw asWakeBackendError(err, "enter");
    }
  }
}

function asWakeBackendError(err: unknown, failurePhase?: "type" | "enter"): WakeBackendError {
  const e = err as NodeJS.ErrnoException & { code?: unknown; signal?: unknown };
  const exitCode = typeof e.code === "number" ? e.code : null;
  const signal = typeof e.signal === "string" ? (e.signal as NodeJS.Signals) : null;
  return Object.assign(new Error((e as Error).message ?? "cmux send-surface failed"), {
    exitCode,
    signal,
    ...(failurePhase !== undefined ? { failurePhase } : {}),
  });
}
