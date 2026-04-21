import { execFile } from "child_process";
import { promisify } from "util";
import type { Logger } from "./logger.js";
import { SESSION_NAME_REGEX } from "./peer-bus-constants.js";

const execFileAsync = promisify(execFile);

const TMUX_DANGEROUS_CHARS = /[#`$;&|\n\r]/g;
const NOTIFIER_TIMEOUT_MS = 5000;

export function scrubForTmux(s: string): string {
  return s.replace(TMUX_DANGEROUS_CHARS, "");
}

export interface FireTmuxNotifierArgs {
  recipientName: string;
  from: string;
  kind: string;
  format: string;
  tabStyle: string;
  logger: Logger;
}

export async function fireTmuxNotifier(args: FireTmuxNotifierArgs): Promise<void> {
  const { recipientName, from, kind, format, tabStyle, logger } = args;

  if (!SESSION_NAME_REGEX.test(recipientName)) {
    logger.error("notifier-tmux: invalid recipient name, skipping", {
      recipient: JSON.stringify(recipientName),
    });
    return;
  }

  const safeFrom = scrubForTmux(from);
  const safeKind = scrubForTmux(kind);
  const formatted = format
    .replace(/\{from\}/g, safeFrom)
    .replace(/\{kind\}/g, safeKind);

  try {
    await execFileAsync("tmux", ["display-message", "-t", recipientName, formatted], {
      timeout: NOTIFIER_TIMEOUT_MS,
    });
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { killed?: boolean; signal?: string };
    logger.warn("notifier-tmux: display-message failed", {
      recipient: recipientName,
      code: e.code,
      signal: e.signal,
      killed: e.killed === true,
    });
    return; // don't try the second subprocess if the first died on ENOENT
  }

  try {
    await execFileAsync(
      "tmux",
      ["set-window-option", "-t", recipientName, "window-status-style", tabStyle],
      { timeout: NOTIFIER_TIMEOUT_MS }
    );
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { killed?: boolean; signal?: string };
    logger.warn("notifier-tmux: set-window-option failed", {
      recipient: recipientName,
      code: e.code,
      signal: e.signal,
      killed: e.killed === true,
    });
  }
}
