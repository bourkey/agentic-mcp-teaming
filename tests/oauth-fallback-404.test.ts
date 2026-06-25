import { describe, it, expect, afterEach } from "vitest";
import { startCoordinator, stopCoordinator, type Coordinator } from "./serve-harness.js";

// The JSON 404 catch-all for MCP-client OAuth-discovery probes. Without it, a
// mis-pathed Streamable HTTP client falls back to OAuth DCR, hits Express's
// default HTML 404, and crashes parsing it as OAuth error JSON. These tests
// assert the scoped paths return parseable JSON and everything else is untouched.

let coord: Coordinator | null = null;

afterEach(async () => {
  await stopCoordinator(coord);
  coord = null;
});

const OAUTH_PROBES: Array<{ method: string; path: string }> = [
  { method: "POST", path: "/register" },
  { method: "POST", path: "/authorize" },
  { method: "POST", path: "/token" },
  { method: "GET", path: "/.well-known/oauth-authorization-server" },
  { method: "GET", path: "/.well-known/oauth-protected-resource" },
];

describe("OAuth-discovery JSON 404 catch-all", () => {
  it("OAuth-discovery paths return 404 with application/json and the exact body", async () => {
    coord = await startCoordinator();
    const baseUrl = `http://127.0.0.1:${coord.port}`;

    for (const probe of OAUTH_PROBES) {
      const res = await fetch(`${baseUrl}${probe.path}`, { method: probe.method });
      expect(res.status, `${probe.method} ${probe.path} status`).toBe(404);
      expect(res.headers.get("content-type"), `${probe.method} ${probe.path} content-type`).toBe("application/json");
      const text = await res.text();
      expect(text).toBe('{"error":"not_found","error_description":"oauth_not_supported"}');
    }
  }, 30000);

  it("every OAuth-path response parses as JSON with error == not_found", async () => {
    coord = await startCoordinator();
    const baseUrl = `http://127.0.0.1:${coord.port}`;

    for (const probe of OAUTH_PROBES) {
      const res = await fetch(`${baseUrl}${probe.path}`, { method: probe.method });
      const text = await res.text();
      const parsed = JSON.parse(text) as { error: string; error_description: string };
      expect(parsed.error).toBe("not_found");
      expect(parsed.error_description).toBe("oauth_not_supported");
    }
  }, 30000);

  it("matches an OAuth path with a trailing slash", async () => {
    coord = await startCoordinator();
    const res = await fetch(`http://127.0.0.1:${coord.port}/register/`, { method: "POST" });
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toBe("application/json");
    expect(await res.text()).toBe('{"error":"not_found","error_description":"oauth_not_supported"}');
  }, 30000);

  it("non-OAuth 404 is unchanged (Express default HTML, not the JSON catch-all)", async () => {
    coord = await startCoordinator();
    const res = await fetch(`http://127.0.0.1:${coord.port}/does-not-exist`, { method: "POST" });
    expect(res.status).toBe(404);
    const ct = res.headers.get("content-type") ?? "";
    expect(ct).not.toContain("application/json");
    const text = await res.text();
    expect(text).not.toBe('{"error":"not_found","error_description":"oauth_not_supported"}');
  }, 30000);
});
