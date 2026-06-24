## Why

The coordinator's HTTP server is plain HTTP (`http://`, no TLS), bound to `127.0.0.1` by default. That is fine for a single-machine loopback deployment, but the project is heading toward a **hosted coordinator with agent panes on separate machines** working the same project. The moment the coordinator binds beyond loopback, every byte crosses the network in cleartext: the `Authorization: Bearer` token, the `X-Pane-Token` pane credential, and every peer-bus message body — which routinely carries sensitive project content. Today there is no transport encryption, and nothing stops an operator from binding to `0.0.0.0` over plain HTTP and silently exposing all of it.

This change adds **native TLS** to the coordinator so cross-machine deployments encrypt traffic in transit, hardens the bind so plaintext cannot accidentally leave loopback, and (now that the server can be network-reachable) closes the DNS-rebinding vector the `coordinator-streamable-http` change explicitly deferred.

This is **transport confidentiality, not end-to-end encryption.** The coordinator remains a trusted component that reads message bodies to route, render envelopes, and validate workflow events. Coordinator-blind E2EE and metadata hiding are out of scope (see below).

## What Changes

### Native TLS on the coordinator HTTP server

- New optional `tls` block in `mcp-config.json`: `certFile`, `keyFile`, optional `caFile`, optional `requireClientCert`.
- When `tls` is configured, `startHttpServer` serves the Express app via `https.createServer({ cert, key, ... })` instead of bare `app.listen`. Both transports (`/sse` + `/message`, `/mcp`) and the OAuth-404 catch-all are served over TLS with no per-route changes.
- Clients connect with `https://` URLs; the bearer token and `X-Pane-Token` now travel inside the TLS tunnel.

### Optional mutual TLS (client-cert auth)

- When `tls.requireClientCert: true` and `caFile` is set, the server requests and verifies client certificates. Each agent machine presents a cert signed by the configured CA — machine-level authentication layered on top of the bearer/pane tokens. A connection without a valid client cert is rejected at the TLS layer, before any HTTP handler runs.

### HSTS (HTTP Strict Transport Security)

- When TLS is active, the coordinator SHALL emit a `Strict-Transport-Security` response header on every response, **only over the HTTPS listener** (never over plain HTTP, where it is meaningless and ignored).
- Configurable via `tls.hsts`: `maxAge` (default `31536000` — one year), `includeSubDomains` (default off), `preload` (default off, validated to require `includeSubDomains` + `maxAge ≥ 31536000`). On by default when TLS is configured; set `tls.hsts.enabled: false` to suppress.
- Motivation: the operator runs a `.dev` domain, and the entire `.dev` TLD is on the browser HSTS-preload list — browsers already force HTTPS for `*.dev`. Emitting the header formalises that policy and covers any browser-adjacent access (health checks, a future web UI). MCP SDK transport clients are CLI and do not honour HSTS, so this is hygiene/defense-in-depth, not the primary wire protection (that is TLS itself).

### Bind hardening — no accidental plaintext exposure

- If `host` resolves to a **non-loopback** address and `tls` is **not** configured, the coordinator refuses to start (fail-closed) with a clear error. An explicit `allowInsecureNonLoopback: true` escape hatch is required to override (for trusted private networks / proxy-fronted deploys). Loopback-only plaintext — the current default — keeps working unchanged.

### DNS-rebinding protection

- Now that the coordinator can be network-reachable, the Streamable HTTP transport enables the SDK's host/origin allowlist (`allowedHosts` / `allowedOrigins`) sourced from config, closing the DNS-rebinding vector deferred by `coordinator-streamable-http`.

### Docs

- `README.md`: TLS + mTLS config examples, `https://` `.mcp.json` snippets, and the bind-hardening behaviour.
- `docs/peer-bus-runbook.md`: cross-machine deployment notes (cert provisioning, client-cert distribution, the fail-closed guard).

## Capabilities

### Modified Capabilities

- `mcp-integration`: the coordinator HTTP server SHALL support TLS termination (`https`) with optional mutual-TLS client-certificate verification; SHALL fail closed on a non-loopback plaintext bind absent an explicit opt-out; and SHALL apply DNS-rebinding host/origin allowlisting when serving the Streamable HTTP transport on a network interface.

## Impact

- **`src/config.ts`**: new optional `tls` block (`certFile`, `keyFile`, `caFile?`, `requireClientCert?`, `hsts?`) and `allowInsecureNonLoopback?` flag, with validation (cert/key both present; caFile required when `requireClientCert`; `preload` requires `includeSubDomains` + `maxAge ≥ 31536000`).
- **`src/server/index.ts`**: `startHttpServer` gains TLS options; `https.createServer` path when TLS configured; HSTS response-header middleware active only on the HTTPS listener; bind-hardening guard; `allowedHosts`/`allowedOrigins` on the Streamable HTTP transport.
- **`src/index.ts`**: read cert/key/ca files and thread TLS + hardening config into `startHttpServer` for both `serve` and `start` paths.
- **New dependencies**: none — Node built-in `https`, `tls`, `fs`.
- **Tests**: TLS handshake against a self-signed cert; mTLS accept (valid client cert) and reject (no/invalid client cert); bind-hardening fail-closed on non-loopback without TLS; plaintext loopback still works; existing SSE/streamable tests unaffected.
- **Docs**: README transport/deployment section + runbook cross-machine notes.
- **No wire-protocol change**: same routes, same auth contract — only the transport is wrapped in TLS. Existing loopback `http://` deployments are unaffected (TLS is opt-in).

## Out of Scope (explicitly deferred)

- **End-to-end (coordinator-blind) encryption of message bodies** and **metadata hiding** (who-talked-to-whom, `kind`, timestamps). The coordinator stays a trusted component; routing requires plaintext metadata. A true-E2EE design is a separate, much larger change.
- **At-rest encryption** of `messages.jsonl` / `registry.json`. Distinct concern; TLS covers the wire, not the disk.
- **Automatic certificate issuance/renewal** (ACME / Let's Encrypt). The operator provides `cert`/`key`; a TLS-terminating reverse proxy remains a documented alternative for ACME-managed certs.
- **Reverse-proxy deployment as the primary path** — native TLS is the supported in-app option; the proxy pattern is documented in the runbook as an alternative, not built.
