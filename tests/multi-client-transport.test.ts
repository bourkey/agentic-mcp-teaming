import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { spawn, type ChildProcess } from "child_process";
import * as net from "net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";

// Regression test for multi-client SSE transport.
//
// The original `startHttpServer` took a single McpServer instance and called
// `.connect()` on it for each SSE connection. The SDK's McpServer enforces
// one-transport-per-instance, so the second concurrent client triggered:
//   "Already connected to a transport. Call close() before connecting to a
//    new transport, or use a separate Protocol instance per connection."
// This test asserts two concurrent MCP clients can each register a session
// and get back their own token successfully.

let workDir: string;
let child: ChildProcess | null = null;

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

function waitForPort(port: number, timeoutMs = 10000): Promise<void> {
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

function waitForExit(c: ChildProcess, timeoutMs = 10000): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      c.kill("SIGKILL");
      reject(new Error(`process did not exit within ${timeoutMs}ms`));
    }, timeoutMs);
    c.once("exit", () => { clearTimeout(timer); resolve(); });
  });
}

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), "multi-client-test-"));
});

afterEach(async () => {
  if (child !== null && child.exitCode === null) {
    child.kill("SIGTERM");
    await waitForExit(child, 5000).catch(() => {});
  }
  child = null;
  await rm(workDir, { recursive: true, force: true });
});

describe("multi-client SSE transport (regression for startHttpServer one-server-per-connection)", () => {
  it("two concurrent MCP clients can each register_session without transport conflict", async () => {
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
    }), "utf8");
    const sessionsDir = join(workDir, "sessions");

    child = spawn("npx", ["tsx", "src/index.ts", "serve", "--config", configPath, "--sessions-dir", sessionsDir], {
      cwd: process.cwd(),
      stdio: ["ignore", "pipe", "pipe"],
    });
    await waitForPort(port, 10000);

    // Open two concurrent MCP clients against the same HTTP MCP server.
    const clientA = new Client({ name: "test-client-a", version: "0.0.0" });
    const clientB = new Client({ name: "test-client-b", version: "0.0.0" });
    const transportA = new SSEClientTransport(new URL(`http://127.0.0.1:${port}/sse`));
    const transportB = new SSEClientTransport(new URL(`http://127.0.0.1:${port}/sse`));

    await clientA.connect(transportA);
    await clientB.connect(transportB);

    try {
      // Both clients call register_session. Neither should throw.
      const resultA = await clientA.callTool({
        name: "register_session",
        arguments: { name: "alpha", paneToken: "test-pane-token-at-minimum-32-bytes" },
      });
      const resultB = await clientB.callTool({
        name: "register_session",
        arguments: { name: "beta", paneToken: "test-pane-token-at-minimum-32-bytes" },
      });

      // Parse the tool text content on each side.
      const payloadA = JSON.parse((resultA.content as Array<{ text: string }>)[0]!.text) as { name: string; sessionToken: string };
      const payloadB = JSON.parse((resultB.content as Array<{ text: string }>)[0]!.text) as { name: string; sessionToken: string };

      expect(payloadA.name).toBe("alpha");
      expect(payloadB.name).toBe("beta");
      expect(payloadA.sessionToken).not.toBe(payloadB.sessionToken);
      expect(resultA.isError).toBeFalsy();
      expect(resultB.isError).toBeFalsy();
    } finally {
      await clientA.close().catch(() => {});
      await clientB.close().catch(() => {});
    }
  }, 30000);

  it("round-trip between two clients: A sends to B, B reads", async () => {
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
    }), "utf8");
    const sessionsDir = join(workDir, "sessions");

    child = spawn("npx", ["tsx", "src/index.ts", "serve", "--config", configPath, "--sessions-dir", sessionsDir], {
      cwd: process.cwd(),
      stdio: ["ignore", "pipe", "pipe"],
    });
    await waitForPort(port, 10000);

    const clientA = new Client({ name: "test-client-a", version: "0.0.0" });
    const clientB = new Client({ name: "test-client-b", version: "0.0.0" });
    const transportA = new SSEClientTransport(new URL(`http://127.0.0.1:${port}/sse`));
    const transportB = new SSEClientTransport(new URL(`http://127.0.0.1:${port}/sse`));
    await clientA.connect(transportA);
    await clientB.connect(transportB);

    try {
      const regA = JSON.parse((await clientA.callTool({ name: "register_session", arguments: { name: "sender", paneToken: "test-pane-token-at-minimum-32-bytes" } })).content[0].text);
      const regB = JSON.parse((await clientB.callTool({ name: "register_session", arguments: { name: "receiver", paneToken: "test-pane-token-at-minimum-32-bytes" } })).content[0].text);

      const sendResult = await clientA.callTool({
        name: "send_message",
        arguments: {
          sessionToken: regA.sessionToken,
          to: "receiver",
          kind: "chat",
          body: "hello from A",
        },
      });
      expect(sendResult.isError).toBeFalsy();

      const readResult = await clientB.callTool({
        name: "read_messages",
        arguments: { sessionToken: regB.sessionToken },
      });
      expect(readResult.isError).toBeFalsy();
      const readPayload = JSON.parse((readResult.content as Array<{ text: string }>)[0]!.text) as {
        messages: Array<{ wrapped: string }>;
        hasMore: boolean;
      };
      expect(readPayload.messages.length).toBe(1);
      expect(readPayload.messages[0]!.wrapped).toContain("hello from A");
      expect(readPayload.hasMore).toBe(false);
    } finally {
      await clientA.close().catch(() => {});
      await clientB.close().catch(() => {});
    }
  }, 30000);
});
