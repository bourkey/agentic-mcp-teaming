import { describe, it, expect, vi, beforeEach } from "vitest";
import { execFile } from "child_process";
import type { Logger } from "../src/core/logger.js";

vi.mock("child_process", () => ({
  execFile: vi.fn(),
}));

const DEFAULT_FORMAT = "peer-bus: from {from} kind {kind}";
const DEFAULT_STYLE = "bg=yellow";

function makeLogger(): {
  logger: Logger;
  warnings: Array<{ message: string; meta: Record<string, unknown> | undefined }>;
  errors: Array<{ message: string; meta: Record<string, unknown> | undefined }>;
} {
  const warnings: Array<{ message: string; meta: Record<string, unknown> | undefined }> = [];
  const errors: Array<{ message: string; meta: Record<string, unknown> | undefined }> = [];
  const logger: Logger = {
    info: () => {},
    warn: (message, meta) => { warnings.push({ message, meta }); },
    error: (message, meta) => { errors.push({ message, meta }); },
  };
  return { logger, warnings, errors };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("scrubForTmux", () => {
  it("removes every dangerous character", async () => {
    const { scrubForTmux } = await import("../src/core/notifier-tmux.js");
    expect(scrubForTmux("a#b`c$d;e&f|g\nh\ri")).toBe("abcdefghi");
  });

  it("leaves safe characters alone", async () => {
    const { scrubForTmux } = await import("../src/core/notifier-tmux.js");
    expect(scrubForTmux("hello world 42")).toBe("hello world 42");
    expect(scrubForTmux("main-frontend")).toBe("main-frontend");
  });
});

describe("fireTmuxNotifier", () => {
  it("invokes execFile with the correct argv for both subcommands on success", async () => {
    vi.mocked(execFile).mockImplementation(((_cmd: string, _args: unknown, _opts: unknown, cb: unknown) => {
      const callback = cb as (err: Error | null, stdout: string, stderr: string) => void;
      callback(null, "", "");
      return {} as ReturnType<typeof execFile>;
    }) as unknown as typeof execFile);

    const { fireTmuxNotifier } = await import("../src/core/notifier-tmux.js");
    const { logger } = makeLogger();

    await fireTmuxNotifier({
      recipientName: "frontend",
      from: "main",
      kind: "chat",
      format: DEFAULT_FORMAT,
      tabStyle: DEFAULT_STYLE,
      logger,
    });

    expect(execFile).toHaveBeenCalledTimes(2);
    const firstCall = vi.mocked(execFile).mock.calls[0];
    expect(firstCall?.[0]).toBe("tmux");
    expect(firstCall?.[1]).toEqual([
      "display-message",
      "-t",
      "frontend",
      "peer-bus: from main kind chat",
    ]);
    const secondCall = vi.mocked(execFile).mock.calls[1];
    expect(secondCall?.[1]).toEqual([
      "set-window-option",
      "-t",
      "frontend",
      "window-status-style",
      "bg=yellow",
    ]);
  });

  it("scrubs dangerous characters from substituted values", async () => {
    vi.mocked(execFile).mockImplementation(((_cmd: string, _args: unknown, _opts: unknown, cb: unknown) => {
      const callback = cb as (err: Error | null, stdout: string, stderr: string) => void;
      callback(null, "", "");
      return {} as ReturnType<typeof execFile>;
    }) as unknown as typeof execFile);

    const { fireTmuxNotifier } = await import("../src/core/notifier-tmux.js");
    const { logger } = makeLogger();

    await fireTmuxNotifier({
      recipientName: "frontend",
      from: "attacker#(whoami)",
      kind: "ch`at",
      format: DEFAULT_FORMAT,
      tabStyle: DEFAULT_STYLE,
      logger,
    });

    const firstCall = vi.mocked(execFile).mock.calls[0];
    expect(firstCall?.[1]).toEqual([
      "display-message",
      "-t",
      "frontend",
      "peer-bus: from attacker(whoami) kind chat",
    ]);
  });

  it("rejects invalid recipient name and skips subprocess call entirely", async () => {
    const { fireTmuxNotifier } = await import("../src/core/notifier-tmux.js");
    const { logger, errors } = makeLogger();

    await fireTmuxNotifier({
      recipientName: "Bad Name!",
      from: "main",
      kind: "chat",
      format: DEFAULT_FORMAT,
      tabStyle: DEFAULT_STYLE,
      logger,
    });

    expect(execFile).not.toHaveBeenCalled();
    expect(errors.length).toBe(1);
  });

  it("swallows ENOENT and logs a warning; function resolves successfully", async () => {
    const err = new Error("ENOENT") as NodeJS.ErrnoException;
    err.code = "ENOENT";
    vi.mocked(execFile).mockImplementation(((_cmd: string, _args: unknown, _opts: unknown, cb: unknown) => {
      const callback = cb as (err: Error | null, stdout: string, stderr: string) => void;
      callback(err, "", "");
      return {} as ReturnType<typeof execFile>;
    }) as unknown as typeof execFile);

    const { fireTmuxNotifier } = await import("../src/core/notifier-tmux.js");
    const { logger, warnings } = makeLogger();

    await expect(
      fireTmuxNotifier({
        recipientName: "frontend",
        from: "main",
        kind: "chat",
        format: DEFAULT_FORMAT,
        tabStyle: DEFAULT_STYLE,
        logger,
      })
    ).resolves.toBeUndefined();

    expect(warnings.length).toBe(1);
    expect(warnings[0]?.meta?.["code"]).toBe("ENOENT");
  });

  it("swallows set-window-option failure independently", async () => {
    let call = 0;
    vi.mocked(execFile).mockImplementation(((_cmd: string, _args: unknown, _opts: unknown, cb: unknown) => {
      const callback = cb as (err: Error | null, stdout: string, stderr: string) => void;
      call += 1;
      if (call === 1) {
        callback(null, "", "");
      } else {
        const err = new Error("style fail");
        callback(err, "", "");
      }
      return {} as ReturnType<typeof execFile>;
    }) as unknown as typeof execFile);

    const { fireTmuxNotifier } = await import("../src/core/notifier-tmux.js");
    const { logger, warnings } = makeLogger();

    await expect(
      fireTmuxNotifier({
        recipientName: "frontend",
        from: "main",
        kind: "chat",
        format: DEFAULT_FORMAT,
        tabStyle: DEFAULT_STYLE,
        logger,
      })
    ).resolves.toBeUndefined();

    expect(warnings.length).toBe(1);
  });

  it("does not invoke set-window-option if display-message fails", async () => {
    const err = new Error("ENOENT") as NodeJS.ErrnoException;
    err.code = "ENOENT";
    vi.mocked(execFile).mockImplementation(((_cmd: string, _args: unknown, _opts: unknown, cb: unknown) => {
      const callback = cb as (err: Error | null, stdout: string, stderr: string) => void;
      callback(err, "", "");
      return {} as ReturnType<typeof execFile>;
    }) as unknown as typeof execFile);

    const { fireTmuxNotifier } = await import("../src/core/notifier-tmux.js");
    const { logger } = makeLogger();

    await fireTmuxNotifier({
      recipientName: "frontend",
      from: "main",
      kind: "chat",
      format: DEFAULT_FORMAT,
      tabStyle: DEFAULT_STYLE,
      logger,
    });

    expect(execFile).toHaveBeenCalledTimes(1);
  });
});
