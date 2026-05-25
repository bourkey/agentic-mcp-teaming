/**
 * Pluggable backend for auto-wake injection. The dispatcher owns the policy
 * (allowlist resolution, debounce, audit, counters, failure handling); the
 * backend owns the backend-specific I/O (pane-state probe, keystroke delivery).
 *
 * v1 ships one implementation, `TmuxWakeBackend`. The interface is shaped so a
 * future zellij / kitty / screen backend is a drop-in replacement.
 */
export interface WakeBackend {
  /**
   * Probe the recipient pane's current command and test it against the
   * operator-configured allowlist. Used as a safety gate to avoid injecting
   * keystrokes into interactive prompts (sudo, git commit, pagers, permission
   * dialogs) where a queued Enter could auto-confirm a destructive operation.
   *
   * On any probe failure (backend unreachable, pane not found, non-zero exit)
   * the implementation SHALL return `{ safe: false, currentCommand: "<probe_failed>" }`
   * so the dispatcher treats probe failure as unsafe — never dispatches.
   *
   * `suppressReason` is optional: when set, the dispatcher uses it as the
   * `wake_suppressed` audit reason instead of the default `"pane_state_unsafe"`.
   * Backends whose probe is permanently disabled (e.g. `CmuxWakeBackend`) set
   * `suppressReason: "probe_disabled"` to distinguish the case from a genuinely
   * unsafe pane.
   */
  isPaneStateSafe(target: string): Promise<{
    safe: boolean;
    currentCommand: string;
    suppressReason?: "probe_disabled" | "pane_state_unsafe";
  }>;

  /**
   * Deliver the resolved command as keystrokes to the target pane. Throws
   * on any failure with a child-process-style error shape (message, optional
   * `exitCode`, optional `signal`). The dispatcher handles logging, auditing,
   * and counter increment.
   */
  sendKeys(target: string, resolvedCommand: string): Promise<void>;
}

export interface WakeBackendError extends Error {
  exitCode?: number | null;
  signal?: NodeJS.Signals | null;
  /**
   * Distinguishes half-delivered wakes: `"type"` means the first `send-keys -l`
   * failed (nothing reached the pane); `"enter"` means the literal command was
   * typed but the follow-up Enter did not land. Operators may need manual
   * cleanup (Ctrl-U) in the `"enter"` case. Absent for non-backend errors
   * (e.g. invalid target).
   */
  failurePhase?: "type" | "enter";
}
