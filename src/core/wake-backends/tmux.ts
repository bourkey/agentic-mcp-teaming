import { execFile } from "child_process";
import { promisify } from "util";
import { SESSION_NAME_REGEX } from "../peer-bus-constants.js";
import type { WakeBackend, WakeBackendError } from "../wake-backend.js";

const execFileAsync = promisify(execFile);

const WAKE_TMUX_TIMEOUT_MS = 5000;
const PROBE_FAILED_SENTINEL = "<probe_failed>";

export interface TmuxWakeBackendOptions {
  /**
   * Snapshot of the pane-state safety-gate allowlist. Captured at backend
   * construction — v1 does not hot-reload config. Comparison is trimmed and
   * case-sensitive against `tmux display-message '#{pane_current_command}'`.
   */
  allowedPaneCommands: ReadonlyArray<string>;
}

/**
 * Tmux implementation of WakeBackend. Uses only `execFile` (never `exec`,
 * never `spawn { shell: true }`) with arguments passed as arrays. No field
 * of any caller input is interpolated into a shell string.
 */
export class TmuxWakeBackend implements WakeBackend {
  private readonly allowedPaneCommands: ReadonlySet<string>;

  constructor(opts: TmuxWakeBackendOptions) {
    this.allowedPaneCommands = new Set(opts.allowedPaneCommands);
  }

  async isPaneStateSafe(target: string): Promise<{ safe: boolean; currentCommand: string }> {
    if (!SESSION_NAME_REGEX.test(target)) {
      return { safe: false, currentCommand: PROBE_FAILED_SENTINEL };
    }
    try {
      const { stdout } = await execFileAsync(
        "tmux",
        ["display-message", "-p", "-t", target, "#{pane_current_command}"],
        { timeout: WAKE_TMUX_TIMEOUT_MS }
      );
      const currentCommand = stdout.trim();
      const safe = this.allowedPaneCommands.has(currentCommand);
      return { safe, currentCommand };
    } catch {
      return { safe: false, currentCommand: PROBE_FAILED_SENTINEL };
    }
  }

  async sendKeys(target: string, resolvedCommand: string): Promise<void> {
    if (!SESSION_NAME_REGEX.test(target)) {
      throw asWakeBackendError(new Error("invalid target"));
    }
    if (resolvedCommand.trim().length === 0) {
      // Defense-in-depth: the config schema rejects empty values at load, but
      // the backend is a public surface; a future caller that skipped the
      // allowlist path would otherwise inject a naked Enter into the pane.
      throw asWakeBackendError(new Error("resolvedCommand must be non-empty"));
    }
    try {
      await execFileAsync(
        "tmux",
        ["send-keys", "-l", "-t", target, resolvedCommand],
        { timeout: WAKE_TMUX_TIMEOUT_MS }
      );
    } catch (err) {
      throw asWakeBackendError(err, "type");
    }
    try {
      await execFileAsync(
        "tmux",
        ["send-keys", "-t", target, "Enter"],
        { timeout: WAKE_TMUX_TIMEOUT_MS }
      );
    } catch (err) {
      // Failure HERE is the "half-delivered" case: the resolved command was
      // already typed into the pane but the Enter didn't land. Mark the phase
      // so operators can triage (may need a manual Enter or Ctrl-U cleanup).
      throw asWakeBackendError(err, "enter");
    }
  }
}

function asWakeBackendError(err: unknown, failurePhase?: "type" | "enter"): WakeBackendError {
  const e = err as NodeJS.ErrnoException & { code?: unknown; signal?: unknown };
  const exitCode = typeof e.code === "number" ? e.code : null;
  const signal = typeof e.signal === "string" ? (e.signal as NodeJS.Signals) : null;
  return Object.assign(new Error((e as Error).message ?? "tmux send-keys failed"), {
    exitCode,
    signal,
    ...(failurePhase !== undefined ? { failurePhase } : {}),
  });
}
