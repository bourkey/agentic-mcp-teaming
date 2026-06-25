/**
 * Tests for X-Pane-Token header threading through startHttpServer.
 *
 * 3.3: GET /sse with valid token → serverFactory called with that token
 * 3.4: GET /sse without token → serverFactory called with undefined
 * 3.6: GET /sse with token < 32 bytes → serverFactory called with undefined (length floor)
 * 3.7: POST /message with a different X-Pane-Token → serverFactory still called only once (at GET time)
 */
import { describe, it, expect, afterEach } from "vitest";
import * as net from "net";
import * as http from "http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { startHttpServer } from "../src/server/index.js";

async function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (typeof addr === "object" && addr !== null) {
        const port = addr.port;
        server.close(() => resolve(port));
      } else {
        reject(new Error("no port"));
      }
    });
  });
}

type SseConnection = { sessionId: string; close: () => void };

function openSseConnection(
  port: number,
  headers: Record<string, string> = {}
): Promise<SseConnection> {
  return new Promise((resolve, reject) => {
    let buffer = "";
    let resolved = false;
    const req = http.get(`http://127.0.0.1:${port}/sse`, {
      headers: { Accept: "text/event-stream", ...headers },
    }, (res) => {
      res.on("data", (chunk: Buffer) => {
        buffer += chunk.toString("utf8");
        const lines = buffer.split("\n");
        for (const line of lines) {
          if (line.startsWith("data: /message?sessionId=") && !resolved) {
            resolved = true;
            const sessionId = line.slice("data: /message?sessionId=".length).trim();
            resolve({ sessionId, close: () => req.destroy() });
          }
        }
      });
      res.once("error", reject);
      res.once("end", () => {
        if (!resolved) reject(new Error("SSE stream ended without sessionId event"));
      });
    });
    req.once("error", reject);
    setTimeout(() => {
      if (!resolved) reject(new Error("SSE connect timeout"));
    }, 5000);
  });
}

function postMessage(port: number, sessionId: string, body: string, extraHeaders: Record<string, string> = {}): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: "127.0.0.1",
      port,
      path: `/message?sessionId=${encodeURIComponent(sessionId)}`,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body, "utf8"),
        ...extraHeaders,
      },
    }, (res) => {
      res.resume();
      res.once("end", () => resolve(res.statusCode ?? 0));
    });
    req.once("error", reject);
    req.write(body);
    req.end();
  });
}

function postMcpInitialize(port: number, extraHeaders: Record<string, string> = {}): Promise<number> {
  const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "t", version: "0.0.0" } } });
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: "127.0.0.1", port, path: "/mcp", method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", "Content-Length": Buffer.byteLength(body, "utf8"), ...extraHeaders },
    }, (res) => {
      res.resume();
      res.once("end", () => resolve(res.statusCode ?? 0));
    });
    req.once("error", reject);
    req.write(body);
    req.end();
  });
}

let stopServer: (() => void) | null = null;

afterEach(() => {
  if (stopServer !== null) {
    stopServer();
    stopServer = null;
  }
});

describe("startHttpServer: X-Pane-Token header threading", () => {
  it("3.3 GET /sse with valid X-Pane-Token calls serverFactory with the trimmed token", async () => {
    const port = await getFreePort();
    const capturedTokens: Array<string | undefined> = [];

    stopServer = await startHttpServer(
      (paneToken) => {
        capturedTokens.push(paneToken);
        return new McpServer({ name: "test", version: "0.0.0" });
      },
      port
    );

    const token = "a".repeat(32); // exactly 32 bytes — at the floor
    const conn = await openSseConnection(port, { "x-pane-token": token });
    conn.close();

    expect(capturedTokens).toHaveLength(1);
    expect(capturedTokens[0]).toBe(token);
  });

  it("POST /mcp initialize with valid X-Pane-Token calls serverFactory with the trimmed token", async () => {
    const port = await getFreePort();
    const capturedTokens: Array<string | undefined> = [];

    stopServer = await startHttpServer(
      (paneToken) => {
        capturedTokens.push(paneToken);
        return new McpServer({ name: "test", version: "0.0.0" });
      },
      port
    );

    const token = "b".repeat(40);
    const status = await postMcpInitialize(port, { "x-pane-token": token });
    expect(status).toBe(200);
    expect(capturedTokens).toEqual([token]);
  });

  it("3.3 GET /sse with token containing leading/trailing whitespace is trimmed before comparison", async () => {
    const port = await getFreePort();
    const capturedTokens: Array<string | undefined> = [];

    stopServer = await startHttpServer(
      (paneToken) => {
        capturedTokens.push(paneToken);
        return new McpServer({ name: "test", version: "0.0.0" });
      },
      port
    );

    const rawToken = "  " + "b".repeat(32) + "  ";
    const conn = await openSseConnection(port, { "x-pane-token": rawToken });
    conn.close();

    expect(capturedTokens).toHaveLength(1);
    expect(capturedTokens[0]).toBe("b".repeat(32));
  });

  it("3.4 GET /sse without X-Pane-Token calls serverFactory with undefined", async () => {
    const port = await getFreePort();
    const capturedTokens: Array<string | undefined> = [];

    stopServer = await startHttpServer(
      (paneToken) => {
        capturedTokens.push(paneToken);
        return new McpServer({ name: "test", version: "0.0.0" });
      },
      port
    );

    const conn = await openSseConnection(port); // no header
    conn.close();

    expect(capturedTokens).toHaveLength(1);
    expect(capturedTokens[0]).toBeUndefined();
  });

  it("3.6 GET /sse with X-Pane-Token shorter than 32 bytes calls serverFactory with undefined", async () => {
    const port = await getFreePort();
    const capturedTokens: Array<string | undefined> = [];

    stopServer = await startHttpServer(
      (paneToken) => {
        capturedTokens.push(paneToken);
        return new McpServer({ name: "test", version: "0.0.0" });
      },
      port
    );

    const shortToken = "c".repeat(31); // 31 bytes — below the 32-byte floor
    const conn = await openSseConnection(port, { "x-pane-token": shortToken });
    conn.close();

    expect(capturedTokens).toHaveLength(1);
    expect(capturedTokens[0]).toBeUndefined();
  });

  it("3.6 GET /sse with whitespace-only X-Pane-Token calls serverFactory with undefined", async () => {
    const port = await getFreePort();
    const capturedTokens: Array<string | undefined> = [];

    stopServer = await startHttpServer(
      (paneToken) => {
        capturedTokens.push(paneToken);
        return new McpServer({ name: "test", version: "0.0.0" });
      },
      port
    );

    const conn = await openSseConnection(port, { "x-pane-token": "   " });
    conn.close();

    expect(capturedTokens).toHaveLength(1);
    expect(capturedTokens[0]).toBeUndefined();
  });

  it("3.7 POST /message with different X-Pane-Token does not trigger another serverFactory call", async () => {
    const port = await getFreePort();
    let factoryCallCount = 0;
    const capturedTokens: Array<string | undefined> = [];

    stopServer = await startHttpServer(
      (paneToken) => {
        factoryCallCount += 1;
        capturedTokens.push(paneToken);
        return new McpServer({ name: "test", version: "0.0.0" });
      },
      port
    );

    const TOKEN_A = "a".repeat(32);
    const TOKEN_B = "b".repeat(32);

    const conn = await openSseConnection(port, { "x-pane-token": TOKEN_A });

    // Factory called once with TOKEN_A
    expect(factoryCallCount).toBe(1);
    expect(capturedTokens[0]).toBe(TOKEN_A);

    // POST /message with a different X-Pane-Token header
    const rpcBody = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" });
    await postMessage(port, conn.sessionId, rpcBody, { "x-pane-token": TOKEN_B });

    // Factory still called exactly once — POST does not create a new server instance
    expect(factoryCallCount).toBe(1);
    expect(capturedTokens).not.toContain(TOKEN_B);

    conn.close();
  });
});
