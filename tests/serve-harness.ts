import { mkdtemp, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { spawn, type ChildProcess } from "child_process";
import * as net from "net";

// Shared test harness for launching the coordinator in `serve` mode against a
// free port with a temp config + sessions dir. Used by the transport tests
// (streamable-http, coexistence, oauth-fallback). Mirrors the inline helpers in
// multi-client-transport.test.ts, factored out so the transport tests don't each
// re-implement port allocation and process lifecycle.

export async function getFreePort(): Promise<number> {
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

export function waitForPort(port: number, timeoutMs = 10000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const tick = (): void => {
      const socket = net.createConnection({ host: "127.0.0.1", port }, () => {
        socket.end();
        resolve();
      });
      socket.on("error", () => {
        socket.destroy();
        if (Date.now() >= deadline) reject(new Error(`port ${port} not listening`));
        else setTimeout(tick, 100);
      });
    };
    tick();
  });
}

export function waitForExit(c: ChildProcess, timeoutMs = 10000): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      c.kill("SIGKILL");
      reject(new Error(`process did not exit within ${timeoutMs}ms`));
    }, timeoutMs);
    c.once("exit", () => { clearTimeout(timer); resolve(); });
  });
}

export interface Coordinator {
  port: number;
  child: ChildProcess;
  workDir: string;
}

export interface StartCoordinatorOptions {
  /** Extra fields merged into mcp-config.json (e.g. authTokenEnvVar). */
  config?: Record<string, unknown>;
  /** Extra env vars for the child process (e.g. COORDINATOR_AUTH_TOKEN). */
  env?: Record<string, string>;
}

/**
 * Launch the coordinator in serve mode. Returns the port, child process, and
 * temp workDir. Caller is responsible for `stopCoordinator`.
 */
export async function startCoordinator(opts: StartCoordinatorOptions = {}): Promise<Coordinator> {
  const workDir = await mkdtemp(join(tmpdir(), "transport-test-"));
  const port = await getFreePort();
  const configPath = join(workDir, "mcp-config.json");
  await writeFile(configPath, JSON.stringify({
    port,
    host: "127.0.0.1",
    toolAllowlist: ["register_session", "send_message", "read_messages"],
    agents: {
      ghost: { cli: "definitely-not-installed", canReview: true, canRevise: true, canImplement: true },
    },
    peerBus: { enabled: true },
    ...opts.config,
  }), "utf8");
  const sessionsDir = join(workDir, "sessions");

  const child = spawn(
    "npx",
    ["tsx", "src/index.ts", "serve", "--config", configPath, "--sessions-dir", sessionsDir],
    {
      cwd: process.cwd(),
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, ...opts.env },
    },
  );
  await waitForPort(port, 10000);
  return { port, child, workDir };
}

export async function stopCoordinator(c: Coordinator | null): Promise<void> {
  if (c === null) return;
  if (c.child.exitCode === null) {
    c.child.kill("SIGTERM");
    await waitForExit(c.child, 5000).catch(() => {});
  }
  await rm(c.workDir, { recursive: true, force: true });
}
