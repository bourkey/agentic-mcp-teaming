import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { spawn, type ChildProcess } from "child_process";
import * as http from "http";
import * as net from "net";

let workDir: string;

async function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (typeof address === "object" && address !== null) {
        const port = address.port;
        server.close(() => resolve(port));
      } else {
        reject(new Error("no port"));
      }
    });
  });
}

function waitForPort(port: number, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const tick = (): void => {
      const socket = net.createConnection({ host: "127.0.0.1", port }, () => {
        socket.end();
        resolve();
      });
      socket.on("error", () => {
        socket.destroy();
        if (Date.now() >= deadline) {
          reject(new Error(`port ${port} not listening within ${timeoutMs}ms`));
        } else {
          setTimeout(tick, 100);
        }
      });
    };
    tick();
  });
}

function waitForExit(child: ChildProcess, timeoutMs = 10000): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`process did not exit within ${timeoutMs}ms`));
    }, timeoutMs);
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
  });
}

function probeSSE(port: number, path = "/sse"): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: "127.0.0.1", port, path, timeout: 2000 }, (res) => {
      const status = res.statusCode ?? 0;
      res.destroy();
      resolve(status);
    });
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("probe timeout")); });
  });
}

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), "serve-mode-test-"));
});

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

describe("serve subcommand", () => {
  it("exits with code 1 and stderr names peerBus.enabled when peer bus is disabled", async () => {
    const configPath = join(workDir, "mcp-config.json");
    await writeFile(
      configPath,
      JSON.stringify({
        toolAllowlist: ["read_file"],
        agents: { a: { cli: "definitely-not-installed", canReview: true, canRevise: true, canImplement: true } },
      }),
      "utf8",
    );

    const child = spawn("npx", ["tsx", "src/index.ts", "serve", "--config", configPath, "--sessions-dir", join(workDir, "sessions")], {
      cwd: process.cwd(),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });

    const { code } = await waitForExit(child, 15000);
    expect(code).toBe(1);
    expect(stderr).toMatch(/peerBus\.enabled/);
  }, 20000);

  it("starts when peer bus enabled, serves /sse, and exits cleanly on SIGTERM", async () => {
    const port = await getFreePort();
    const configPath = join(workDir, "mcp-config.json");
    await writeFile(
      configPath,
      JSON.stringify({
        port,
        host: "127.0.0.1",
        toolAllowlist: ["register_session", "send_message", "read_messages"],
        agents: {
          // Non-existent CLI: serve MUST NOT validate agent CLIs
          ghost: { cli: "definitely-not-installed", canReview: true, canRevise: true, canImplement: true },
        },
        peerBus: { enabled: true },
      }),
      "utf8",
    );
    const sessionsDir = join(workDir, "sessions");

    const child = spawn("npx", ["tsx", "src/index.ts", "serve", "--config", configPath, "--sessions-dir", sessionsDir], {
      cwd: process.cwd(),
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (c: Buffer) => { stdout += c.toString("utf8"); });
    child.stderr?.on("data", (c: Buffer) => { stderr += c.toString("utf8"); });

    try {
      await waitForPort(port, 10000);
      // SSE probe without auth returns 200 on loopback (no token configured)
      const status = await probeSSE(port);
      expect(status).toBe(200);
      // Coordinator should still be up a second later — would have died by now if lifecycle were phase-bound
      await new Promise((r) => setTimeout(r, 500));
      expect(child.exitCode).toBeNull();
    } finally {
      child.kill("SIGTERM");
    }

    const { code } = await waitForExit(child, 10000);
    // On SIGTERM clean shutdown — exit code 0 is expected but some Node versions return null with signal SIGTERM
    expect(code === 0 || code === null).toBe(true);
    // Stdout should say "running on"
    expect(stdout).toMatch(/running on/);
    // Agent CLI validation did not run — no error about missing CLI
    expect(stderr).not.toMatch(/definitely-not-installed/);
  }, 30000);
});
