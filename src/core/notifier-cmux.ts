import { execFile } from "child_process";
import { promisify } from "util";
import type { Logger } from "./logger.js";
import type { PeerBusConfig } from "../config.js";

const execFileAsync = promisify(execFile);

const CMUX_WORKSPACE_ID_REGEX = /^workspace:\d+$/;
const NOTIFIER_TIMEOUT_MS = 5000;
const NOTIFY_BODY_MAX_BYTES = 256;
const BADGE_KEY = "peer-bus";

/**
 * Strips C0 control characters (U+0000–U+001F), DEL (U+007F), and newlines
 * from a string before passing it to the cmux CLI. Does NOT strip tmux
 * format-language characters (# { }) — those are not relevant here.
 *
 * Also truncates to NOTIFY_BODY_MAX_BYTES UTF-8 bytes, appending `…` if
 * truncated, to prevent notification popup flooding.
 */
export function scrubForCmux(s: string): string {
  // eslint-disable-next-line no-control-regex
  const scrubbed = s.replace(/[\x00-\x1F\x7F\n\r]/g, "");
  const buf = Buffer.from(scrubbed, "utf8");
  if (buf.byteLength <= NOTIFY_BODY_MAX_BYTES) return scrubbed;
  // Truncate at byte boundary without splitting a multibyte sequence
  let end = NOTIFY_BODY_MAX_BYTES - 3; // reserve 3 bytes for '…' (U+2026, 3 UTF-8 bytes)
  // Back off until we're not mid-sequence (first byte of a sequence is 0b0xxxxxxx or 0b11xxxxxx)
  while (end > 0 && (buf[end]! & 0xc0) === 0x80) end -= 1;
  return buf.slice(0, end).toString("utf8") + "…";
}

function formatNotifyBody(config: PeerBusConfig["notifier"], from: string, kind: string): string {
  return config.displayMessageFormat
    .replace(/\{from\}/g, scrubForCmux(from))
    .replace(/\{kind\}/g, scrubForCmux(kind));
}

export interface FireCmuxNotifierArgs {
  notifierConfig: PeerBusConfig["notifier"];
  from: string;
  kind: string;
  logger: Logger;
}

export async function fireCmuxNotifier(args: FireCmuxNotifierArgs): Promise<void> {
  const { notifierConfig, from, kind, logger } = args;
  const body = formatNotifyBody(notifierConfig, from, kind);
  try {
    await execFileAsync(
      "cmux",
      ["notify", "--title", "peer-bus", "--body", body],
      { timeout: NOTIFIER_TIMEOUT_MS }
    );
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { killed?: boolean; signal?: string };
    const message = e.code === "ENOENT"
      ? "cmux binary not found — check PATH"
      : "fireCmuxNotifier failed";
    logger.warn(`notifier-cmux: ${message}`, {
      code: e.code,
      signal: e.signal,
      killed: e.killed === true,
    });
  }
}

function validateWorkspaceId(workspaceId: string, logger: Logger): boolean {
  if (!CMUX_WORKSPACE_ID_REGEX.test(workspaceId)) {
    logger.warn("notifier-cmux: invalid cmuxWorkspaceId, skipping badge call", {
      workspaceId: JSON.stringify(workspaceId),
    });
    return false;
  }
  return true;
}

export async function setCmuxBadge(workspaceId: string, logger: Logger): Promise<void> {
  if (!validateWorkspaceId(workspaceId, logger)) return;
  try {
    await execFileAsync(
      "cmux",
      ["set-status", BADGE_KEY, "unread", "--workspace", workspaceId],
      { timeout: NOTIFIER_TIMEOUT_MS }
    );
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { killed?: boolean; signal?: string };
    logger.warn("notifier-cmux: set-status failed", {
      workspaceId,
      code: e.code,
      signal: e.signal,
      killed: e.killed === true,
    });
  }
}

export async function clearCmuxBadge(workspaceId: string, logger: Logger): Promise<void> {
  if (!validateWorkspaceId(workspaceId, logger)) return;
  try {
    await execFileAsync(
      "cmux",
      ["clear-status", BADGE_KEY, "--workspace", workspaceId],
      { timeout: NOTIFIER_TIMEOUT_MS }
    );
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { killed?: boolean; signal?: string };
    logger.warn("notifier-cmux: clear-status failed", {
      workspaceId,
      code: e.code,
      signal: e.signal,
      killed: e.killed === true,
    });
  }
}
