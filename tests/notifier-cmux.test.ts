import { describe, it, expect, vi, beforeEach } from "vitest";
import { execFile } from "child_process";
import { scrubForCmux, fireCmuxNotifier, setCmuxBadge, clearCmuxBadge } from "../src/core/notifier-cmux.js";

vi.mock("child_process", async () => {
  const util = await import("util");
  const customSymbol = (util.promisify as unknown as { custom: symbol }).custom;
  const mock: unknown = vi.fn();
  const promisified = (cmd: string, args: string[], options?: unknown): Promise<{ stdout: string; stderr: string }> =>
    new Promise((resolve, reject) => {
      (mock as (...a: unknown[]) => unknown)(cmd, args, options ?? {}, (err: Error | null, stdout: string, stderr: string) => {
        if (err !== null) {
          (err as unknown as { stdout?: string; stderr?: string }).stdout = stdout;
          (err as unknown as { stdout?: string; stderr?: string }).stderr = stderr;
          reject(err);
        } else {
          resolve({ stdout, stderr });
        }
      });
    });
  Object.defineProperty(mock, customSymbol, { value: promisified });
  return { execFile: mock };
});

type Cb = (
  err: (NodeJS.ErrnoException & { killed?: boolean; signal?: NodeJS.Signals }) | null,
  stdout: string,
  stderr: string
) => void;

function mockExecFileSuccess(): void {
  vi.mocked(execFile).mockImplementation(((...args: unknown[]) => {
    const cb = args[args.length - 1] as Cb;
    setImmediate(() => cb(null, "", ""));
    return {} as never;
  }) as unknown as typeof execFile);
}

function mockExecFileError(code: string): void {
  vi.mocked(execFile).mockImplementation(((...args: unknown[]) => {
    const cb = args[args.length - 1] as Cb;
    setImmediate(() => {
      const err = Object.assign(new Error(code), { code }) as NodeJS.ErrnoException;
      cb(err, "", "");
    });
    return {} as never;
  }) as unknown as typeof execFile);
}

function callsTo(cmd: string): Array<readonly string[]> {
  const mock = vi.mocked(execFile);
  const out: Array<readonly string[]> = [];
  for (const call of mock.mock.calls) {
    const [bin, args] = call as unknown as [string, string[]];
    if (bin === cmd) out.push(args);
  }
  return out;
}

const makeLogger = () => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  log: vi.fn(),
  debug: vi.fn(),
});

const defaultNotifierConfig = {
  tmuxEnabled: false,
  cmuxEnabled: true,
  displayMessageFormat: "peer-bus: from {from} kind {kind}",
  unreadTabStyle: "bg=yellow",
};

beforeEach(() => {
  vi.clearAllMocks();
});

// ──────────────────────────────────────────────────────────
// scrubForCmux
// ──────────────────────────────────────────────────────────
describe("scrubForCmux", () => {
  it("strips C0 control characters", () => {
    expect(scrubForCmux("\x00\x01\x1F hello")).toBe(" hello");
  });

  it("strips DEL (0x7F)", () => {
    expect(scrubForCmux("abc\x7Fdef")).toBe("abcdef");
  });

  it("strips newlines and carriage returns", () => {
    expect(scrubForCmux("line1\nline2\r")).toBe("line1line2");
  });

  it("preserves printable ASCII", () => {
    expect(scrubForCmux("hello world!")).toBe("hello world!");
  });

  it("truncates at 256 bytes with ellipsis", () => {
    const long = "a".repeat(300);
    const result = scrubForCmux(long);
    expect(Buffer.byteLength(result, "utf8")).toBeLessThanOrEqual(256);
    expect(result.endsWith("…")).toBe(true);
  });

  it("leaves short strings unchanged", () => {
    expect(scrubForCmux("short")).toBe("short");
  });
});

// ──────────────────────────────────────────────────────────
// fireCmuxNotifier
// ──────────────────────────────────────────────────────────
describe("fireCmuxNotifier", () => {
  it("calls execFile with expected cmux notify argv using displayMessageFormat", async () => {
    mockExecFileSuccess();
    const logger = makeLogger();
    await fireCmuxNotifier({
      notifierConfig: defaultNotifierConfig,
      from: "claude-main",
      kind: "workflow-event",
      logger,
    });
    const calls = callsTo("cmux");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.[0]).toBe("notify");
    expect(calls[0]?.[1]).toBe("--title");
    expect(calls[0]?.[2]).toBe("peer-bus");
    expect(calls[0]?.[3]).toBe("--body");
    expect(calls[0]?.[4]).toBe("peer-bus: from claude-main kind workflow-event");
  });

  it("emits warn containing 'cmux binary not found' on ENOENT and does not throw", async () => {
    mockExecFileError("ENOENT");
    const logger = makeLogger();
    await expect(fireCmuxNotifier({
      notifierConfig: defaultNotifierConfig,
      from: "claude-main",
      kind: "chat",
      logger,
    })).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("cmux binary not found"),
      expect.any(Object)
    );
  });

  it("emits warn on non-zero exit without throwing", async () => {
    mockExecFileError("EPERM");
    const logger = makeLogger();
    await expect(fireCmuxNotifier({
      notifierConfig: defaultNotifierConfig,
      from: "main",
      kind: "chat",
      logger,
    })).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalled();
  });
});

// ──────────────────────────────────────────────────────────
// setCmuxBadge
// ──────────────────────────────────────────────────────────
describe("setCmuxBadge", () => {
  it("calls execFile with set-status peer-bus unread --workspace", async () => {
    mockExecFileSuccess();
    const logger = makeLogger();
    await setCmuxBadge("workspace:2", logger);
    const calls = callsTo("cmux");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual(["set-status", "peer-bus", "unread", "--workspace", "workspace:2"]);
  });

  it("emits warn and skips execFile when workspaceId is invalid", async () => {
    const mock = vi.mocked(execFile);
    const logger = makeLogger();
    await setCmuxBadge("--evil-flag", logger);
    expect(mock).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("invalid cmuxWorkspaceId"),
      expect.any(Object)
    );
  });

  it("emits warn on execFile failure without throwing", async () => {
    mockExecFileError("ENOENT");
    const logger = makeLogger();
    await expect(setCmuxBadge("workspace:1", logger)).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalled();
  });
});

// ──────────────────────────────────────────────────────────
// clearCmuxBadge
// ──────────────────────────────────────────────────────────
describe("clearCmuxBadge", () => {
  it("calls execFile with clear-status peer-bus --workspace", async () => {
    mockExecFileSuccess();
    const logger = makeLogger();
    await clearCmuxBadge("workspace:3", logger);
    const calls = callsTo("cmux");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual(["clear-status", "peer-bus", "--workspace", "workspace:3"]);
  });

  it("emits warn and skips execFile when workspaceId is invalid", async () => {
    const mock = vi.mocked(execFile);
    const logger = makeLogger();
    await clearCmuxBadge("surface:3", logger); // wrong type — surface not workspace
    expect(mock).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalled();
  });
});

describe("scrubForCmux: multibyte truncation boundary", () => {
  it("truncates correctly at a 2-byte UTF-8 boundary (é = U+00E9, 2 bytes)", () => {
    // 'é' is 2 bytes in UTF-8 — 200 × 2 = 400 bytes
    const input = "é".repeat(200);
    const result = scrubForCmux(input);
    expect(Buffer.byteLength(result, "utf8")).toBeLessThanOrEqual(256);
    expect(result.endsWith("…")).toBe(true);
    // Verify the result is valid UTF-8 (Buffer.from → toString round-trip is lossless)
    expect(Buffer.from(result, "utf8").toString("utf8")).toBe(result);
  });

  it("truncates correctly at a 3-byte UTF-8 boundary (€ = U+20AC, 3 bytes)", () => {
    // '€' is 3 bytes — 100 × 3 = 300 bytes
    const input = "€".repeat(100);
    const result = scrubForCmux(input);
    expect(Buffer.byteLength(result, "utf8")).toBeLessThanOrEqual(256);
    expect(result.endsWith("…")).toBe(true);
    expect(Buffer.from(result, "utf8").toString("utf8")).toBe(result);
  });

  it("does not truncate a string that is exactly 256 bytes", () => {
    const input = "a".repeat(256);
    const result = scrubForCmux(input);
    expect(result).toBe(input);
    expect(result.endsWith("…")).toBe(false);
  });
});
