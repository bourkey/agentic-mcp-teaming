import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { writeFile, rm, mkdir, symlink } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import {
  readFileTool,
  writeFileTool,
  grepTool,
  bashTool,
  type SharedToolsContext,
} from "../src/server/tools/shared.js";

let rootDir: string;
let ctx: SharedToolsContext;

beforeAll(async () => {
  rootDir = join(tmpdir(), `mcp-test-${Date.now()}`);
  await mkdir(rootDir, { recursive: true });
  await writeFile(join(rootDir, "fixture.txt"), "hello world\nfoo bar\n", "utf8");
  ctx = {
    rootDir,
    allowlist: new Set(["read_file", "write_file", "grep", "glob", "bash"]),
  };
});

afterAll(async () => {
  await rm(rootDir, { recursive: true, force: true });
});

describe("readFileTool", () => {
  it("reads an existing file", async () => {
    const result = await readFileTool(ctx, { path: "fixture.txt" });
    expect(result).toContain("hello world");
  });

  it("rejects path traversal", async () => {
    await expect(readFileTool(ctx, { path: "../etc/passwd" })).rejects.toThrow("escapes");
  });

  it("throws when tool not in allowlist", async () => {
    const restricted = { ...ctx, allowlist: new Set<string>() };
    await expect(readFileTool(restricted, { path: "fixture.txt" })).rejects.toThrow("allowlist");
  });
});

describe("writeFileTool", () => {
  it("writes and returns confirmation", async () => {
    const result = await writeFileTool(ctx, { path: "out.txt", content: "written" });
    expect(result).toContain("out.txt");
    const read = await readFileTool(ctx, { path: "out.txt" });
    expect(read).toBe("written");
  });

  it("rejects writes through symlinks that escape rootDir", async () => {
    const outsideDir = join(tmpdir(), `mcp-outside-${Date.now()}`);
    await mkdir(outsideDir, { recursive: true });
    await writeFile(join(outsideDir, "target.txt"), "outside", "utf8");
    await symlink(join(outsideDir, "target.txt"), join(rootDir, "escape-link"));

    await expect(
      writeFileTool(ctx, { path: "escape-link", content: "mutated" })
    ).rejects.toThrow("symlink");

    await rm(outsideDir, { recursive: true, force: true });
  });
});

describe("grepTool", () => {
  it("finds matching lines", async () => {
    const result = await grepTool(ctx, { pattern: "hello", path: "fixture.txt" });
    expect(result).toContain("hello world");
  });

  it("returns empty string when no match", async () => {
    const result = await grepTool(ctx, { pattern: "zzznomatch", path: "fixture.txt" });
    expect(result).toBe("");
  });
});

describe("bashTool", () => {
  it("executes a simple command", async () => {
    const result = await bashTool(ctx, { command: "echo hello-from-bash" });
    expect(result.trim()).toBe("hello-from-bash");
  });

  it("throws when tool not in allowlist", async () => {
    const restricted = { ...ctx, allowlist: new Set<string>() };
    await expect(bashTool(restricted, { command: "echo x" })).rejects.toThrow("allowlist");
  });
});
