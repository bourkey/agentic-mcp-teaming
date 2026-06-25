import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import * as http from "node:http";
import * as https from "node:https";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config.js";
import { coordinatorSseUrl } from "../src/server/index.js";
import { startCoordinator, stopCoordinator, type Coordinator } from "./serve-harness.js";
import { generateTlsFixtures, type TlsFixtures } from "./tls-fixtures.js";

let tls: TlsFixtures;
let coord: Coordinator | null = null;

beforeAll(() => { tls = generateTlsFixtures(); });
afterAll(() => { tls.cleanup(); });
afterEach(async () => { await stopCoordinator(coord); coord = null; });

interface Resp { status: number; headers: http.IncomingHttpHeaders }

function request(
  mod: typeof http | typeof https,
  opts: http.RequestOptions | https.RequestOptions,
  body?: string,
): Promise<Resp> {
  return new Promise((resolve, reject) => {
    const req = mod.request(opts, (res) => {
      res.resume();
      resolve({ status: res.statusCode ?? 0, headers: res.headers });
    });
    req.on("error", reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

const INIT_BODY = JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "raw", version: "0.0.0" } },
});

describe("coordinator TLS transport", () => {
  it("serves https with a CA-trusted client and emits HSTS by default", async () => {
    coord = await startCoordinator({
      config: { tls: { certFile: tls.serverCertPath, keyFile: tls.serverKeyPath } },
    });
    const res = await request(https, {
      host: "127.0.0.1", port: coord.port, path: "/register", method: "POST", ca: tls.caCert,
    });
    expect(res.status).toBe(404); // OAuth-404 catch-all, proving TLS serves the app
    expect(res.headers["strict-transport-security"]).toBe("max-age=31536000");
  }, 30000);

  it("runs the MCP initialize handshake over https", async () => {
    coord = await startCoordinator({
      config: { tls: { certFile: tls.serverCertPath, keyFile: tls.serverKeyPath } },
    });
    const res = await request(https, {
      host: "127.0.0.1", port: coord.port, path: "/mcp", method: "POST", ca: tls.caCert,
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    }, INIT_BODY);
    expect(res.status).toBe(200);
    expect(res.headers["mcp-session-id"]).toBeDefined();
    // HSTS covers the client-facing transports, not just /register (T7).
    expect(res.headers["strict-transport-security"]).toBe("max-age=31536000");
  }, 30000);

  it("emits HSTS on the /sse stream response under TLS", async () => {
    coord = await startCoordinator({
      config: { tls: { certFile: tls.serverCertPath, keyFile: tls.serverKeyPath } },
    });
    const res = await request(https, {
      host: "127.0.0.1", port: coord.port, path: "/sse", method: "GET", ca: tls.caCert,
    });
    expect(res.status).toBe(200);
    expect(res.headers["strict-transport-security"]).toBe("max-age=31536000");
  }, 30000);

  it("suppresses HSTS when tls.hsts.enabled is false", async () => {
    coord = await startCoordinator({
      config: { tls: { certFile: tls.serverCertPath, keyFile: tls.serverKeyPath, hsts: { enabled: false } } },
    });
    const res = await request(https, {
      host: "127.0.0.1", port: coord.port, path: "/register", method: "POST", ca: tls.caCert,
    });
    expect(res.headers["strict-transport-security"]).toBeUndefined();
  }, 30000);

  it("never emits HSTS over plain HTTP", async () => {
    coord = await startCoordinator(); // no tls → plain http, loopback
    const res = await request(http, {
      host: "127.0.0.1", port: coord.port, path: "/register", method: "POST",
    });
    expect(res.status).toBe(404);
    expect(res.headers["strict-transport-security"]).toBeUndefined();
  }, 30000);

  it("mutual TLS admits a client with a CA-signed cert", async () => {
    coord = await startCoordinator({
      config: { tls: { certFile: tls.serverCertPath, keyFile: tls.serverKeyPath, caFile: tls.caCertPath, requireClientCert: true } },
    });
    const res = await request(https, {
      host: "127.0.0.1", port: coord.port, path: "/register", method: "POST",
      ca: tls.caCert, cert: tls.clientCert, key: tls.clientKey,
    });
    expect(res.status).toBe(404);
  }, 30000);

  it("mutual TLS rejects a client with no certificate at the TLS layer", async () => {
    coord = await startCoordinator({
      config: { tls: { certFile: tls.serverCertPath, keyFile: tls.serverKeyPath, caFile: tls.caCertPath, requireClientCert: true } },
    });
    await expect(
      request(https, {
        host: "127.0.0.1", port: coord.port, path: "/register", method: "POST", ca: tls.caCert,
      }),
    ).rejects.toThrow();
  }, 30000);

  it("mutual TLS rejects a client cert signed by an untrusted CA (the real boundary)", async () => {
    coord = await startCoordinator({
      config: { tls: { certFile: tls.serverCertPath, keyFile: tls.serverKeyPath, caFile: tls.caCertPath, requireClientCert: true } },
    });
    await expect(
      request(https, {
        host: "127.0.0.1", port: coord.port, path: "/register", method: "POST",
        ca: tls.caCert, cert: tls.untrustedClientCert, key: tls.untrustedClientKey,
      }),
    ).rejects.toThrow();
  }, 30000);

  it("DNS-rebinding: rejects a disallowed Host, admits an allowlisted Host", async () => {
    coord = await startCoordinator({ config: { allowedHosts: ["allowed.test"] } });
    const base = { host: "127.0.0.1", port: coord.port, path: "/mcp", method: "POST" as const };
    const headers = { "Content-Type": "application/json", Accept: "application/json, text/event-stream" };

    const denied = await request(http, { ...base, headers: { ...headers, Host: "evil.test" } }, INIT_BODY);
    expect(denied.status).toBe(403);

    const allowed = await request(http, { ...base, headers: { ...headers, Host: "allowed.test" } }, INIT_BODY);
    expect(allowed.status).toBe(200);
    expect(allowed.headers["mcp-session-id"]).toBeDefined();

    // host:port form is auto-expanded from the bare host, so a client sending the
    // port (the common case for a non-default port) is also admitted (N17).
    const withPort = await request(http, { ...base, headers: { ...headers, Host: `allowed.test:${coord.port}` } }, INIT_BODY);
    expect(withPort.status).toBe(200);

    // The GET /sse stream open is host-validated too, not just POST /message (N4).
    const sseDenied = await request(http, { host: "127.0.0.1", port: coord.port, path: "/sse", method: "GET", headers: { Host: "evil.test" } });
    expect(sseDenied.status).toBe(403);
    const sseAllowed = await request(http, { host: "127.0.0.1", port: coord.port, path: "/sse", method: "GET", headers: { Host: "allowed.test" } });
    expect(sseAllowed.status).toBe(200);
  }, 30000);

  it("coordinatorSseUrl scheme follows TLS config (sub-agent callback URL)", () => {
    const base = { host: "10.0.0.5", port: 3100 } as const;
    expect(coordinatorSseUrl({ ...base })).toBe("http://10.0.0.5:3100/sse");
    expect(coordinatorSseUrl({ ...base, tls: { certFile: "c", keyFile: "k", hsts: { enabled: true, maxAge: 1, includeSubDomains: false, preload: false } } })).toBe("https://10.0.0.5:3100/sse");
  });

  it("coordinatorSseUrl brackets IPv6 literals and honours advertisedHost", () => {
    const v6 = coordinatorSseUrl({ host: "::1", port: 3100 });
    expect(v6).toBe("http://[::1]:3100/sse");
    expect(() => new URL(v6)).not.toThrow();
    expect(coordinatorSseUrl({ host: "0.0.0.0", port: 3100, advertisedHost: "coord.example.dev" }))
      .toBe("http://coord.example.dev:3100/sse");
  });

  it("config validation rejects hsts.preload without includeSubDomains / year-plus max-age", () => {
    const dir = mkdtempSync(join(tmpdir(), "tls-hsts-"));
    const cfgPath = join(dir, "mcp-config.json");
    writeFileSync(cfgPath, JSON.stringify({
      toolAllowlist: ["register_session"],
      tls: { certFile: "c", keyFile: "k", hsts: { preload: true, includeSubDomains: false, maxAge: 31536000 } },
    }));
    try {
      expect(() => loadConfig(cfgPath)).toThrow(/preload/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("config validation rejects requireClientCert without caFile", () => {
    const dir = mkdtempSync(join(tmpdir(), "tls-cfg-"));
    const cfgPath = join(dir, "mcp-config.json");
    writeFileSync(cfgPath, JSON.stringify({
      toolAllowlist: ["register_session"],
      tls: { certFile: "/x/server.crt", keyFile: "/x/server.key", requireClientCert: true },
    }));
    try {
      expect(() => loadConfig(cfgPath)).toThrow(/caFile is required/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
