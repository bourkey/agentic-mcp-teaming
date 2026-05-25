import { describe, it, expect, vi, beforeEach } from "vitest";
import { execFile } from "child_process";
import { CmuxWakeBackend } from "../src/core/wake-backends/cmux.js";

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

describe("CmuxWakeBackend.isPaneStateSafe", () => {
  it("always returns safe:false with suppressReason: probe_disabled without calling execFile", async () => {
    const mock = vi.mocked(execFile);
    const backend = new CmuxWakeBackend();
    const result = await backend.isPaneStateSafe("surface:3");
    expect(result.safe).toBe(false);
    expect(result.currentCommand).toBe("<probe_disabled>");
    expect(result.suppressReason).toBe("probe_disabled");
    expect(mock).not.toHaveBeenCalled();
  });

  it("returns probe_disabled for any target including invalid", async () => {
    const mock = vi.mocked(execFile);
    const backend = new CmuxWakeBackend();
    const result = await backend.isPaneStateSafe("claude-main");
    expect(result.safe).toBe(false);
    expect(result.suppressReason).toBe("probe_disabled");
    expect(mock).not.toHaveBeenCalled();
  });
});

describe("CmuxWakeBackend.sendKeys", () => {
  it("makes exactly two execFile calls with expected cmux argv", async () => {
    mockExecFileSequence({ stdout: "" }, { stdout: "" });
    const backend = new CmuxWakeBackend();
    await backend.sendKeys("surface:3", "/opsx:peer-inbox");
    const calls = callsTo("cmux");
    expect(calls).toHaveLength(2);
    expect(calls[0]).toEqual(["send-surface", "--surface", "surface:3", "/opsx:peer-inbox"]);
    expect(calls[1]).toEqual(["send-key-surface", "--surface", "surface:3", "enter"]);
  });

  it("rejects invalid target format without invoking execFile", async () => {
    const mock = vi.mocked(execFile);
    const backend = new CmuxWakeBackend();
    await expect(backend.sendKeys("claude-main", "/opsx:peer-inbox")).rejects.toBeInstanceOf(Error);
    expect(mock).not.toHaveBeenCalled();
  });

  it("rejects empty resolved command without invoking execFile", async () => {
    const mock = vi.mocked(execFile);
    const backend = new CmuxWakeBackend();
    await expect(backend.sendKeys("surface:3", "")).rejects.toBeInstanceOf(Error);
    await expect(backend.sendKeys("surface:3", "   ")).rejects.toBeInstanceOf(Error);
    expect(mock).not.toHaveBeenCalled();
  });

  it("throws with failurePhase: 'type' when first execFile call fails", async () => {
    mockExecFileSequence({ err: { code: "ENOENT" } });
    const backend = new CmuxWakeBackend();
    await expect(backend.sendKeys("surface:3", "/opsx:peer-inbox")).rejects.toMatchObject({
      failurePhase: "type",
    });
    expect(callsTo("cmux")).toHaveLength(1);
  });

  it("throws with failurePhase: 'enter' when second execFile call fails", async () => {
    mockExecFileSequence({ stdout: "" }, { err: { code: "ENOENT" } });
    const backend = new CmuxWakeBackend();
    await expect(backend.sendKeys("surface:3", "/opsx:peer-inbox")).rejects.toMatchObject({
      failurePhase: "enter",
    });
    expect(callsTo("cmux")).toHaveLength(2);
  });

  it("passes resolvedCommand as literal argv element (no shell)", async () => {
    mockExecFileSequence({ stdout: "" }, { stdout: "" });
    const backend = new CmuxWakeBackend();
    await backend.sendKeys("surface:7", "/cmd --flag 'with spaces'");
    const calls = callsTo("cmux");
    expect(calls[0]?.[3]).toBe("/cmd --flag 'with spaces'");
  });

  it("accepts surface IDs with multi-digit numbers", async () => {
    mockExecFileSequence({ stdout: "" }, { stdout: "" });
    const backend = new CmuxWakeBackend();
    await backend.sendKeys("surface:42", "/opsx:peer-inbox");
    const calls = callsTo("cmux");
    expect(calls[0]?.[2]).toBe("surface:42");
  });
});
