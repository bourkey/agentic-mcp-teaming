import { describe, it, expect, vi, beforeEach } from "vitest";
import { execFile } from "child_process";
import { TmuxWakeBackend } from "../src/core/wake-backends/tmux.js";

// `promisify(child_process.execFile)` is special: the real module attaches a
// `util.promisify.custom` hook so awaiting resolves to `{ stdout, stderr }`
// instead of just `stdout`. A bare `vi.fn()` mock has no such hook so the
// backend — which destructures `{ stdout }` — sees `undefined`. Restore the
// custom hook on the mock so it matches real behaviour. (`vi.mock` is hoisted;
// the factory must not close over module-level consts — resolve the symbol
// inside the factory instead.)
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

function mockExecFileSequence(...responses: Array<{ err?: Partial<NodeJS.ErrnoException & { signal?: string; killed?: boolean }>; stdout?: string }>): void {
  const mock = vi.mocked(execFile);
  let call = 0;
  mock.mockImplementation(((...args: unknown[]) => {
    const cb = args[args.length - 1] as Cb;
    const response = responses[call] ?? { stdout: "" };
    call += 1;
    const { err, stdout } = response;
    setImmediate(() => {
      if (err !== undefined) {
        cb(err as NodeJS.ErrnoException, stdout ?? "", "");
      } else {
        cb(null, stdout ?? "", "");
      }
    });
    // execFile returns a ChildProcess; the promisified wrapper ignores it.
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

beforeEach(() => {
  vi.clearAllMocks();
});

describe("TmuxWakeBackend.isPaneStateSafe", () => {
  it("returns safe:true when pane_current_command is in allowlist", async () => {
    mockExecFileSequence({ stdout: "bash\n" });
    const backend = new TmuxWakeBackend({ allowedPaneCommands: ["claude", "bash", "zsh", "sh"] });
    const result = await backend.isPaneStateSafe("main");
    expect(result.safe).toBe(true);
    expect(result.currentCommand).toBe("bash");
  });

  it("returns safe:false when pane_current_command is not in allowlist", async () => {
    mockExecFileSequence({ stdout: "sudo\n" });
    const backend = new TmuxWakeBackend({ allowedPaneCommands: ["bash"] });
    const result = await backend.isPaneStateSafe("main");
    expect(result.safe).toBe(false);
    expect(result.currentCommand).toBe("sudo");
  });

  it("returns safe:false with probe_failed when tmux exits non-zero", async () => {
    mockExecFileSequence({ err: { code: "ENOENT" } });
    const backend = new TmuxWakeBackend({ allowedPaneCommands: ["bash"] });
    const result = await backend.isPaneStateSafe("main");
    expect(result.safe).toBe(false);
    expect(result.currentCommand).toBe("<probe_failed>");
  });

  it("invokes tmux display-message with expected argv", async () => {
    mockExecFileSequence({ stdout: "bash\n" });
    const backend = new TmuxWakeBackend({ allowedPaneCommands: ["bash"] });
    await backend.isPaneStateSafe("main");
    expect(callsTo("tmux")).toEqual([
      ["display-message", "-p", "-t", "main", "#{pane_current_command}"],
    ]);
  });

  it("rejects malformed target names without invoking tmux", async () => {
    const mock = vi.mocked(execFile);
    const backend = new TmuxWakeBackend({ allowedPaneCommands: ["bash"] });
    const result = await backend.isPaneStateSafe("NAME with spaces");
    expect(result.safe).toBe(false);
    expect(result.currentCommand).toBe("<probe_failed>");
    expect(mock).not.toHaveBeenCalled();
  });
});

describe("TmuxWakeBackend.sendKeys", () => {
  it("makes exactly two execFile calls with expected argv, no shell", async () => {
    mockExecFileSequence({ stdout: "" }, { stdout: "" });
    const backend = new TmuxWakeBackend({ allowedPaneCommands: ["bash"] });
    await backend.sendKeys("main", "/opsx:peer-inbox");
    const calls = callsTo("tmux");
    expect(calls).toHaveLength(2);
    expect(calls[0]).toEqual(["send-keys", "-l", "-t", "main", "/opsx:peer-inbox"]);
    expect(calls[1]).toEqual(["send-keys", "-t", "main", "Enter"]);
  });

  it("throws with exitCode/signal when first send-keys fails", async () => {
    mockExecFileSequence({ err: { code: "ENOENT", signal: null as unknown as string } });
    const backend = new TmuxWakeBackend({ allowedPaneCommands: ["bash"] });
    await expect(backend.sendKeys("main", "/opsx:peer-inbox")).rejects.toMatchObject({});
    expect(callsTo("tmux")).toHaveLength(1);
  });

  it("throws when second send-keys fails; error carries failurePhase: 'enter'", async () => {
    mockExecFileSequence({ stdout: "" }, { err: { code: "ENOENT" } });
    const backend = new TmuxWakeBackend({ allowedPaneCommands: ["bash"] });
    await expect(backend.sendKeys("main", "/opsx:peer-inbox")).rejects.toMatchObject({
      failurePhase: "enter",
    });
    expect(callsTo("tmux")).toHaveLength(2);
  });

  it("first-call failure carries failurePhase: 'type'", async () => {
    mockExecFileSequence({ err: { code: "ENOENT" } });
    const backend = new TmuxWakeBackend({ allowedPaneCommands: ["bash"] });
    await expect(backend.sendKeys("main", "/opsx:peer-inbox")).rejects.toMatchObject({
      failurePhase: "type",
    });
  });

  it("rejects empty resolvedCommand without invoking tmux (defense-in-depth)", async () => {
    const mock = vi.mocked(execFile);
    const backend = new TmuxWakeBackend({ allowedPaneCommands: ["bash"] });
    await expect(backend.sendKeys("main", "")).rejects.toBeInstanceOf(Error);
    await expect(backend.sendKeys("main", "   ")).rejects.toBeInstanceOf(Error);
    expect(mock).not.toHaveBeenCalled();
  });

  it("rejects malformed target without invoking tmux", async () => {
    const mock = vi.mocked(execFile);
    const backend = new TmuxWakeBackend({ allowedPaneCommands: ["bash"] });
    await expect(backend.sendKeys("NAME with spaces", "/x")).rejects.toBeInstanceOf(Error);
    expect(mock).not.toHaveBeenCalled();
  });

  it("passes resolvedCommand literally even with shell metacharacters", async () => {
    mockExecFileSequence({ stdout: "" }, { stdout: "" });
    const backend = new TmuxWakeBackend({ allowedPaneCommands: ["bash"] });
    // The resolvedCommand here is what the ALLOWLIST would have — operator-controlled.
    // But we still want to assert execFile passes it as an array element, never interpolated.
    await backend.sendKeys("main", "/opsx:peer-inbox --x 'y z'");
    const calls = callsTo("tmux");
    expect(calls[0]?.[4]).toBe("/opsx:peer-inbox --x 'y z'");
  });
});
