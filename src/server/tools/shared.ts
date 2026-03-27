import { execFile } from "child_process";
import { promisify } from "util";
import { readFile, writeFile, realpath, lstat } from "fs/promises";
import { dirname, resolve, relative } from "path";

const execFileAsync = promisify(execFile);

export interface SharedToolsContext {
  rootDir: string;
  allowlist: Set<string>;
}

function assertAllowed(toolName: string, allowlist: Set<string>): void {
  if (!allowlist.has(toolName)) {
    throw new Error(`Tool '${toolName}' is not in the allowlist`);
  }
}

function safePath(rootDir: string, filePath: string): string {
  const abs = resolve(rootDir, filePath);
  const rel = relative(rootDir, abs);
  if (rel.startsWith("..")) {
    throw new Error(`Path '${filePath}' escapes the root directory`);
  }
  return abs;
}

function assertWithinRoot(rootRealPath: string, targetRealPath: string, originalPath: string): void {
  const rel = relative(rootRealPath, targetRealPath);
  if (rel.startsWith("..") || rel === "") {
    if (rel === "") return;
    throw new Error(`Path '${originalPath}' escapes the root directory`);
  }
}

async function safeReadPath(rootDir: string, filePath: string): Promise<string> {
  const rootRealPath = await realpath(rootDir);
  const abs = safePath(rootDir, filePath);
  const targetRealPath = await realpath(abs);
  assertWithinRoot(rootRealPath, targetRealPath, filePath);
  return targetRealPath;
}

async function safeWritePath(rootDir: string, filePath: string): Promise<string> {
  const rootRealPath = await realpath(rootDir);
  const abs = safePath(rootDir, filePath);
  const parentRealPath = await realpath(dirname(abs));
  assertWithinRoot(rootRealPath, parentRealPath, filePath);

  try {
    const stat = await lstat(abs);
    if (stat.isSymbolicLink()) {
      throw new Error(`Path '${filePath}' resolves through a symlink and is not writable`);
    }
  } catch (error: unknown) {
    const fsError = error as NodeJS.ErrnoException;
    if (fsError.code !== "ENOENT") {
      throw error;
    }
  }

  return abs;
}

export async function readFileTool(
  ctx: SharedToolsContext,
  params: { path: string }
): Promise<string> {
  assertAllowed("read_file", ctx.allowlist);
  const abs = await safeReadPath(ctx.rootDir, params.path);
  return readFile(abs, "utf8");
}

export async function writeFileTool(
  ctx: SharedToolsContext,
  params: { path: string; content: string }
): Promise<string> {
  assertAllowed("write_file", ctx.allowlist);
  const abs = await safeWritePath(ctx.rootDir, params.path);
  await writeFile(abs, params.content, "utf8");
  return `Written: ${params.path}`;
}

export async function grepTool(
  ctx: SharedToolsContext,
  params: { pattern: string; path?: string; recursive?: boolean }
): Promise<string> {
  assertAllowed("grep", ctx.allowlist);
  const target = params.path ? safePath(ctx.rootDir, params.path) : ctx.rootDir;
  const args = ["-n", "--include=*"];
  if (params.recursive !== false) args.push("-r");
  args.push(params.pattern, target);
  try {
    const { stdout } = await execFileAsync("grep", args, { cwd: ctx.rootDir });
    return stdout;
  } catch (err: unknown) {
    const ex = err as { code?: number; stdout?: string };
    if (ex.code === 1) return "";
    throw err;
  }
}

export async function globTool(
  ctx: SharedToolsContext,
  params: { pattern: string }
): Promise<string> {
  assertAllowed("glob", ctx.allowlist);
  const { glob } = await import("node:fs/promises");
  const entries: string[] = [];
  for await (const entry of (glob as (pattern: string, options: { cwd: string }) => AsyncIterable<string>)(
    params.pattern,
    { cwd: ctx.rootDir }
  )) {
    entries.push(entry);
  }
  return entries.sort().join("\n");
}

export async function bashTool(
  ctx: SharedToolsContext,
  params: { command: string }
): Promise<string> {
  assertAllowed("bash", ctx.allowlist);
  const { stdout, stderr } = await execFileAsync("bash", ["-c", params.command], {
    cwd: ctx.rootDir,
    timeout: 30_000,
  });
  return [stdout, stderr].filter(Boolean).join("\n");
}
