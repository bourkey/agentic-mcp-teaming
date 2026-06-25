import { describe, it, expect, afterEach } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { startCoordinator, stopCoordinator, type Coordinator } from "./serve-harness.js";

// Streamable HTTP transport (MCP spec 2025-03-26) at POST/GET/DELETE /mcp.
// Mirrors multi-client-transport.test.ts but drives the SDK's
// StreamableHTTPClientTransport against the live coordinator binary.

let coord: Coordinator | null = null;

afterEach(async () => {
  await stopCoordinator(coord);
  coord = null;
});

function parseToolText<T>(result: { content: unknown }): T {
  return JSON.parse((result.content as Array<{ text: string }>)[0]!.text) as T;
}

describe("Streamable HTTP transport (/mcp)", () => {
  it("two concurrent clients each register_session with distinct tokens", async () => {
    coord = await startCoordinator();
    const base = `http://127.0.0.1:${coord.port}/mcp`;

    const clientA = new Client({ name: "http-a", version: "0.0.0" });
    const clientB = new Client({ name: "http-b", version: "0.0.0" });
    const transportA = new StreamableHTTPClientTransport(new URL(base));
    const transportB = new StreamableHTTPClientTransport(new URL(base));
    await clientA.connect(transportA);
    await clientB.connect(transportB);

    try {
      const a = parseToolText<{ name: string; sessionToken: string }>(
        await clientA.callTool({ name: "register_session", arguments: { name: "alpha" } }),
      );
      const b = parseToolText<{ name: string; sessionToken: string }>(
        await clientB.callTool({ name: "register_session", arguments: { name: "beta" } }),
      );
      expect(a.name).toBe("alpha");
      expect(b.name).toBe("beta");
      expect(a.sessionToken).not.toBe(b.sessionToken);
    } finally {
      await clientA.close().catch(() => {});
      await clientB.close().catch(() => {});
    }
  }, 30000);

  it("single-client round-trip: register, send to self, read", async () => {
    coord = await startCoordinator();
    const client = new Client({ name: "http-solo", version: "0.0.0" });
    const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${coord.port}/mcp`));
    await client.connect(transport);

    try {
      const reg = parseToolText<{ sessionToken: string }>(
        await client.callTool({ name: "register_session", arguments: { name: "solo" } }),
      );
      const send = await client.callTool({
        name: "send_message",
        arguments: { sessionToken: reg.sessionToken, to: "solo", kind: "chat", body: "ping self" },
      });
      expect(send.isError).toBeFalsy();

      const read = await client.callTool({
        name: "read_messages",
        arguments: { sessionToken: reg.sessionToken },
      });
      const payload = parseToolText<{ messages: Array<{ wrapped: string }> }>(read);
      expect(payload.messages.length).toBe(1);
      expect(payload.messages[0]!.wrapped).toContain("ping self");
    } finally {
      await client.close().catch(() => {});
    }
  }, 30000);

  it("session id echo: tools/list works after initialize; bogus Mcp-Session-Id returns 404", async () => {
    coord = await startCoordinator();
    const base = `http://127.0.0.1:${coord.port}/mcp`;

    const client = new Client({ name: "http-sid", version: "0.0.0" });
    const transport = new StreamableHTTPClientTransport(new URL(base));
    await client.connect(transport);

    try {
      // The SDK transport echoes the Mcp-Session-Id assigned at initialize on
      // this follow-up request; success proves the header round-trips.
      const tools = await client.listTools();
      expect(tools.tools.some((t) => t.name === "register_session")).toBe(true);

      // A POST with a session id that matches no active session is rejected 404.
      const res = await fetch(base, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          "Mcp-Session-Id": "00000000-0000-0000-0000-000000000000",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 9, method: "tools/list", params: {} }),
      });
      expect(res.status).toBe(404);
    } finally {
      await client.close().catch(() => {});
    }
  }, 30000);

  it("GET /mcp opens an SSE stream for a valid session; 404 for an unknown one", async () => {
    coord = await startCoordinator();
    const base = `http://127.0.0.1:${coord.port}/mcp`;
    const initHeaders = { "Content-Type": "application/json", Accept: "application/json, text/event-stream" };

    const init = await fetch(base, {
      method: "POST",
      headers: initHeaders,
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "raw", version: "0.0.0" } } }),
    });
    const sid = init.headers.get("mcp-session-id");
    expect(sid).toBeTruthy();
    await init.body?.cancel();

    const stream = await fetch(base, { method: "GET", headers: { Accept: "text/event-stream", "Mcp-Session-Id": sid! } });
    expect(stream.status).toBe(200);
    expect(stream.headers.get("content-type") ?? "").toContain("text/event-stream");
    await stream.body?.cancel();

    const bogus = await fetch(base, { method: "GET", headers: { Accept: "text/event-stream", "Mcp-Session-Id": "00000000-0000-0000-0000-000000000000" } });
    expect(bogus.status).toBe(404);
    await bogus.body?.cancel();
  }, 30000);

  it("DELETE /mcp terminates the session (subsequent use is 404)", async () => {
    coord = await startCoordinator();
    const base = `http://127.0.0.1:${coord.port}/mcp`;
    const headers = { "Content-Type": "application/json", Accept: "application/json, text/event-stream" };

    const init = await fetch(base, {
      method: "POST", headers,
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "raw", version: "0.0.0" } } }),
    });
    const sid = init.headers.get("mcp-session-id");
    expect(sid).toBeTruthy();
    await init.body?.cancel();

    const del = await fetch(base, { method: "DELETE", headers: { "Mcp-Session-Id": sid! } });
    expect(del.status).toBeLessThan(300);
    await del.body?.cancel();

    const after = await fetch(base, {
      method: "POST", headers: { ...headers, "Mcp-Session-Id": sid! },
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
    });
    expect(after.status).toBe(404);
    await after.body?.cancel();
  }, 30000);

  it("malformed JSON to /mcp returns a JSON 400, not HTML (no SDK parse crash)", async () => {
    coord = await startCoordinator();
    const res = await fetch(`http://127.0.0.1:${coord.port}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
      body: "{not valid json",
    });
    expect(res.status).toBe(400);
    expect(res.headers.get("content-type") ?? "").toContain("application/json");
    const parsed = JSON.parse(await res.text()) as { error: string };
    expect(parsed.error).toBe("invalid_json");
  }, 30000);

  it("auth: request without bearer is 401; correct bearer succeeds", async () => {
    coord = await startCoordinator({
      config: { authTokenEnvVar: "COORDINATOR_AUTH_TOKEN" },
      env: { COORDINATOR_AUTH_TOKEN: "abc123" },
    });
    const base = `http://127.0.0.1:${coord.port}/mcp`;
    const initBody = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "raw", version: "0.0.0" } },
    });

    // No Authorization header → 401, before any transport is constructed.
    const unauth = await fetch(base, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
      body: initBody,
    });
    expect(unauth.status).toBe(401);

    // Correct bearer → the SDK client connects and registers successfully.
    const client = new Client({ name: "http-auth", version: "0.0.0" });
    const transport = new StreamableHTTPClientTransport(new URL(base), {
      requestInit: { headers: { Authorization: "Bearer abc123" } },
    });
    await client.connect(transport);
    try {
      const reg = parseToolText<{ name: string }>(
        await client.callTool({ name: "register_session", arguments: { name: "authed" } }),
      );
      expect(reg.name).toBe("authed");
    } finally {
      await client.close().catch(() => {});
    }
  }, 30000);
});
