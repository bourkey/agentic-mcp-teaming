## Context

`startHttpServer` in [src/server/index.ts](../../../src/server/index.ts) builds a bare `express()` app and binds it with `app.listen(port, host)` — plain HTTP, default `host: "127.0.0.1"`. It serves three things: the legacy SSE transport (`GET /sse` + `POST /message`), the Streamable HTTP transport (`POST|GET|DELETE /mcp`, added by `coordinator-streamable-http`), and the OAuth-discovery JSON-404 catch-all. Auth is a transport-agnostic `Authorization: Bearer` / `?token=` gate plus the per-pane `X-Pane-Token` connection header.

All of this is unencrypted. On loopback that is acceptable. The driver for this change is a **hosted coordinator with agent panes on separate machines**: once `host` is a routable address, the bearer token, the pane token, and every message body cross the network in cleartext, and nothing prevents an operator from binding `0.0.0.0` over plain HTTP.

`coordinator-streamable-http` explicitly deferred "DNS rebinding protection" and "untrusted networks" to a follow-up — this is that follow-up. Node's built-in `https` and `tls` modules cover everything; no new dependency.

## Goals / Non-Goals

**Goals:**
- Encrypt coordinator traffic in transit (TLS) so cross-machine deployments do not expose tokens or message bodies in cleartext.
- Optional machine-level authentication via mutual TLS (client certs), layered on the existing token auth.
- Make accidental plaintext network exposure impossible by default (fail closed on non-loopback + no TLS).
- Enable DNS-rebinding protection on the Streamable HTTP transport now that it can be network-reachable.
- Zero change for existing loopback `http://` deployments — TLS is strictly opt-in.

**Non-Goals:**
- End-to-end (coordinator-blind) encryption of message bodies; the coordinator stays trusted and continues to render envelopes and validate workflow events.
- Hiding metadata (`to`/`from`/`kind`/timestamps) — routing requires it in clear.
- At-rest encryption of `messages.jsonl` / `registry.json`.
- ACME / automatic cert issuance and renewal.
- Building a reverse-proxy deployment (documented as an alternative only).

## Decisions

### D1 — Native TLS in-process via `https.createServer`

When TLS is configured, wrap the existing Express app: `https.createServer(tlsOptions, app).listen(port, host)` instead of `app.listen(port, host)`. The app, routes, transports, and auth gate are unchanged — TLS is purely the listening socket.

**Alternative considered: TLS-terminating reverse proxy (Caddy/nginx).** Rejected as the primary path — it requires the operator to run and maintain extra infra, and the coordinator's value proposition is a single self-contained `serve` binary deployable anywhere. The proxy pattern is documented in the runbook as an alternative (and is the right answer for ACME-managed certs).

### D2 — Config carries file **paths**, read at startup

`tls.certFile`, `tls.keyFile`, `tls.caFile` are filesystem paths. `src/index.ts` reads them (`fs.readFileSync`) at startup and passes the buffers into `startHttpServer`. The config JSON never contains PEM material.

**Alternative considered: inline PEM strings or env vars.** Rejected — inline PEM puts private-key material in a file that is often committed or copied; multi-line PEM in env vars is awkward. Paths reference operator-managed files (e.g. `/etc/coordinator/tls/`) with their own permissions. Fail fast with a clear error if a path is missing or unreadable.

### D3 — Optional mutual TLS via `requestCert` + `rejectUnauthorized`

When `tls.requireClientCert: true` (requires `caFile`), construct the server with `{ cert, key, ca, requestCert: true, rejectUnauthorized: true }`. The TLS layer rejects any client without a certificate signed by the configured CA, before any HTTP handler runs. This authenticates the agent **machine**; the bearer/pane token still authenticates the **session**. Both apply (defense in depth) — mTLS does not replace the token gate.

**Alternative considered: token-only auth over TLS.** Acceptable and remains the default (mTLS is opt-in). mTLS is offered because "agents on separate machines" is exactly the case where binding identity to a provisioned client cert is worthwhile.

### D4 — Bind hardening: fail closed on non-loopback plaintext

Before listening, if `host` is **non-loopback** AND no `tls` block is configured AND `allowInsecureNonLoopback` is not `true`, the coordinator throws a clear startup error and exits non-zero. Loopback hosts (`127.0.0.0/8`, `::1`, `localhost`) over plain HTTP — the current default — are unaffected. The `allowInsecureNonLoopback: true` escape hatch exists for trusted private networks or proxy-fronted deployments where TLS is terminated upstream.

**Alternative considered: warn-only.** Rejected — the failure being prevented (operator binds `0.0.0.0` plaintext and silently leaks tokens + bodies) is exactly the kind of mistake a log line gets lost behind. Fail-closed makes it impossible to do by accident.

**Loopback detection:** literal match against `127.*`, `::1`, `0:0:...:1`, and `localhost`. A configured hostname that is not a loopback literal is treated conservatively as non-loopback (it may resolve off-box), so it requires TLS or the explicit opt-out. Documented.

### D5 — DNS-rebinding protection on the Streamable HTTP transport (operator-provided allowlist)

`StreamableHTTPServerTransport` supports `enableDnsRebindingProtection` with `allowedHosts` / `allowedOrigins`. Enable it when the operator provides a non-empty `allowedHosts` list in config. The allowlist is **operator-provided, not auto-derived from the bind `host`**: you bind to an IP or `0.0.0.0`, but the `Host` header clients send is the DNS name (e.g. `coordinator.bourkey.dev`), so a derived `host:port` allowlist would reject legitimate traffic. When `allowedHosts` is absent, protection stays off (SDK default). The legacy SSE transport has no built-in equivalent; since SSE is the deprecating transport and the threat is primarily browser-driven (MCP clients here are CLI), this is noted as a residual rather than retrofitted.

**Alternative considered: auto-derive the allowlist from `host:port`.** Rejected — wrong for the common wildcard/IP bind, and would silently break connectivity. Explicit operator config is the only reliable source for the hostnames clients actually use.

### D6 — TLS is opt-in; loopback `http` stays the default

No `tls` block ⇒ behaviour is byte-for-byte today's (`http`, loopback). No forced migration, no behaviour change for existing single-machine users.

### D7 — Certs read once at startup; rotation is a restart

Cert/key/CA are read at startup and held for the process lifetime. Rotation requires a coordinator restart — consistent with how every other config change is applied today, and cert rotation is infrequent. No file-watch/hot-reload machinery.

### D8 — HSTS emitted only over the HTTPS listener, on by default with TLS

When TLS is active, an Express middleware sets `Strict-Transport-Security: max-age=<maxAge>[; includeSubDomains][; preload]` on every response. The middleware is registered only on the HTTPS path — it never runs for a plain-HTTP listener, because RFC 6797 requires user agents to ignore an HSTS header received over a non-secure transport, so emitting it there is pointless and could only mislead. Config lives under `tls.hsts` (`enabled` default true, `maxAge` default `31536000`, `includeSubDomains`/`preload` default false). `preload` is validated to require `includeSubDomains` and `maxAge ≥ 31536000` (the preload-list submission requirements).

`includeSubDomains` and `preload` default **off** deliberately: the operator has sibling services under `*.bourkey.dev` (internal infra at `*.int.bourkey.dev`), and asserting a subtree-wide or preload-list HSTS policy from this one service is a strong, hard-to-reverse commitment (`preload` removal can take months to propagate). Opt-in only.

**Why HSTS at all when MCP clients are CLI:** the SDK transport clients do not honour HSTS, so it is not the primary wire protection — TLS is. But the operator serves on a `.dev` host, and the entire `.dev` TLD is already on the browser preload list, so browsers hard-force HTTPS for any `*.dev`. Emitting the header formalises that policy and protects any browser-adjacent access (health probes, a future web UI, a human hitting the URL). It is cheap, standard hygiene; the honest framing is documented so no one over-reads its protection.

**Alternative considered: skip HSTS (rely on TLS + `.dev` preload alone).** Rejected — the operator asked for it, it is a one-line header, and the `.dev` preload covers browsers but not the explicit per-response policy signal (and says nothing about `includeSubDomains` intent for the specific host).

## Risks / Trade-offs

- **Client trust of the CA.** Self-signed or private-CA server certs must be trusted by each agent's MCP client (`NODE_EXTRA_CA_CERTS` for Node-based SDK clients, or the system trust store). If not, the TLS handshake fails. Document prominently; this is the most common cross-machine setup snag.
- **Private-key file permissions.** The `keyFile` must be readable by the coordinator process and not world-readable. Runbook calls this out (`chmod 600`).
- **mTLS operational overhead.** Distributing and rotating client certs across agent machines is real work; that is why mTLS is optional, not default.
- **SSE-over-HTTPS.** `SSEClientTransport` and `StreamableHTTPClientTransport` both accept `https://` URLs. Tests generate a throwaway CA + server cert at runtime and make the test client **trust that CA** (pass it via the transport's `fetch`/`https.Agent` `ca` option, or `NODE_EXTRA_CA_CERTS`). Tests MUST NOT set `rejectUnauthorized: false` or otherwise disable verification — that would defeat the property under test and violates the project's no-disabled-security-controls rule. The implementation never exposes a verification-disable knob.
- **Hostname-bind edge cases.** Conservative non-loopback treatment means an operator binding a custom hostname that happens to resolve to loopback still needs the opt-out or TLS. Acceptable; the safe default beats a resolver call at startup.

## Migration

- **Existing loopback `http` deployments:** no change, no action.
- **Going cross-machine:**
  1. Provision a server cert + key (and a CA + per-machine client certs for mTLS).
  2. Place the files; `chmod 600` the key.
  3. Add a `tls` block to `mcp-config.json`, set `host` to the bind address, restart the coordinator.
  4. Agents: point `.mcp.json` at `https://<host>:<port>/mcp` (or `/sse`); ensure the client trusts the CA; for mTLS, install the client cert.

  ```json
  {
    "port": 3100,
    "host": "0.0.0.0",
    "authTokenEnvVar": "COORDINATOR_AUTH_TOKEN",
    "tls": {
      "certFile": "/etc/coordinator/tls/server.crt",
      "keyFile": "/etc/coordinator/tls/server.key",
      "caFile": "/etc/coordinator/tls/ca.crt",
      "requireClientCert": true
    }
  }
  ```

## Open Questions

_(None load-bearing; the D-series closes everything needed to ship. ACME and at-rest encryption are deferred to separate changes.)_
