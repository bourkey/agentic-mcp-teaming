import { describe, it, expect, vi, afterEach } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { startHttpServer, isLoopbackHost } from "../src/server/index.js";
import { getFreePort } from "./serve-harness.js";

const factory = (): McpServer => new McpServer({ name: "test", version: "0.0.0" });

let stop: (() => void) | null = null;

afterEach(() => {
  if (stop !== null) { stop(); stop = null; }
  vi.restoreAllMocks();
});

describe("isLoopbackHost", () => {
  it("classifies loopback vs non-loopback", () => {
    for (const h of ["127.0.0.1", "127.1.2.3", "::1", "[::1]", "localhost", "LOCALHOST"]) {
      expect(isLoopbackHost(h), h).toBe(true);
    }
    for (const h of ["0.0.0.0", "192.168.1.10", "10.0.0.1", "coordinator.bourkey.dev", "::"]) {
      expect(isLoopbackHost(h), h).toBe(false);
    }
  });
});

describe("bind hardening", () => {
  it("refuses a non-loopback plaintext bind with no opt-out", async () => {
    const port = await getFreePort();
    await expect(
      startHttpServer(factory, port, "0.0.0.0", undefined, {}),
    ).rejects.toThrow(/non-loopback .* plain HTTP/);
  });

  it("permits a non-loopback plaintext bind with allowInsecureNonLoopback and warns", async () => {
    const port = await getFreePort();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    stop = await startHttpServer(factory, port, "0.0.0.0", undefined, { allowInsecureNonLoopback: true });
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/UNENCRYPTED/));
  });

  it("loopback plaintext bind starts with no warning (unchanged)", async () => {
    const port = await getFreePort();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    stop = await startHttpServer(factory, port, "127.0.0.1", undefined, {});
    expect(warn).not.toHaveBeenCalled();
  });
});
