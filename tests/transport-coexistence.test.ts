import { describe, it, expect, afterEach } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { startCoordinator, stopCoordinator, type Coordinator } from "./serve-harness.js";

// One coordinator instance serving both transports at once: a legacy SSE client
// at /sse and a Streamable HTTP client at /mcp. Proves the peer bus is
// transport-agnostic — a message sent over one transport is read over the other.

let coord: Coordinator | null = null;

afterEach(async () => {
  await stopCoordinator(coord);
  coord = null;
});

function parseToolText<T>(result: { content: unknown }): T {
  return JSON.parse((result.content as Array<{ text: string }>)[0]!.text) as T;
}

describe("transport coexistence (/sse + /mcp on one coordinator)", () => {
  it("SSE and Streamable HTTP clients both register with distinct tokens", async () => {
    coord = await startCoordinator();
    const sseClient = new Client({ name: "sse-c", version: "0.0.0" });
    const httpClient = new Client({ name: "http-c", version: "0.0.0" });
    const sseTransport = new SSEClientTransport(new URL(`http://127.0.0.1:${coord.port}/sse`));
    const httpTransport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${coord.port}/mcp`));
    await sseClient.connect(sseTransport);
    await httpClient.connect(httpTransport);

    try {
      const sse = parseToolText<{ name: string; sessionToken: string }>(
        await sseClient.callTool({ name: "register_session", arguments: { name: "via-sse" } }),
      );
      const http = parseToolText<{ name: string; sessionToken: string }>(
        await httpClient.callTool({ name: "register_session", arguments: { name: "via-http" } }),
      );
      expect(sse.name).toBe("via-sse");
      expect(http.name).toBe("via-http");
      expect(sse.sessionToken).not.toBe(http.sessionToken);
    } finally {
      await sseClient.close().catch(() => {});
      await httpClient.close().catch(() => {});
    }
  }, 30000);

  it("cross-transport message: SSE client sends, Streamable HTTP client reads", async () => {
    coord = await startCoordinator();
    const sseClient = new Client({ name: "sse-c", version: "0.0.0" });
    const httpClient = new Client({ name: "http-c", version: "0.0.0" });
    const sseTransport = new SSEClientTransport(new URL(`http://127.0.0.1:${coord.port}/sse`));
    const httpTransport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${coord.port}/mcp`));
    await sseClient.connect(sseTransport);
    await httpClient.connect(httpTransport);

    try {
      const sender = parseToolText<{ sessionToken: string }>(
        await sseClient.callTool({ name: "register_session", arguments: { name: "sse-sender" } }),
      );
      const receiver = parseToolText<{ sessionToken: string }>(
        await httpClient.callTool({ name: "register_session", arguments: { name: "http-receiver" } }),
      );

      const send = await sseClient.callTool({
        name: "send_message",
        arguments: { sessionToken: sender.sessionToken, to: "http-receiver", kind: "chat", body: "cross-transport hi" },
      });
      expect(send.isError).toBeFalsy();

      const read = await httpClient.callTool({
        name: "read_messages",
        arguments: { sessionToken: receiver.sessionToken },
      });
      const payload = parseToolText<{ messages: Array<{ wrapped: string }> }>(read);
      expect(payload.messages.length).toBe(1);
      expect(payload.messages[0]!.wrapped).toContain("cross-transport hi");
    } finally {
      await sseClient.close().catch(() => {});
      await httpClient.close().catch(() => {});
    }
  }, 30000);
});
