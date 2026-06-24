## ADDED Requirements

### Requirement: Coordinator serves both transports over TLS when configured

When a `tls` block is present in `mcp-config.json`, the coordinator HTTP server SHALL serve the Express app — both the legacy SSE transport (`/sse` + `/message`) and the Streamable HTTP transport (`/mcp`), plus the OAuth-discovery JSON-404 catch-all — over TLS via `https.createServer`. When `tls` is absent, the server SHALL listen over plain HTTP exactly as before this change.

The `tls` block SHALL specify filesystem **paths** (`certFile`, `keyFile`, optional `caFile`); the coordinator SHALL read them at startup and SHALL fail fast with a clear, non-zero-exit error if any configured path is missing or unreadable. The coordinator SHALL NOT expose any option that disables TLS certificate verification.

#### Scenario: TLS configured serves https on both transports
- **WHEN** `mcp-config.json` includes a valid `tls` block with readable `certFile` and `keyFile`
- **THEN** the coordinator SHALL complete a TLS handshake on the configured port, and a client over `https://<host>:<port>/mcp` (and `/sse`) SHALL be able to `register_session` and exchange peer-bus messages

#### Scenario: No TLS block preserves plain HTTP
- **WHEN** `mcp-config.json` has no `tls` block and `host` is loopback
- **THEN** the coordinator SHALL listen over plain HTTP with identical behaviour to before this change

#### Scenario: Unreadable cert/key fails fast
- **WHEN** a `tls` block references a `certFile` or `keyFile` path that does not exist or cannot be read
- **THEN** the coordinator SHALL exit non-zero at startup with an error naming the unreadable path, and SHALL NOT begin listening

### Requirement: Coordinator emits HSTS over the TLS listener

When TLS is active and `tls.hsts.enabled` is not `false`, the coordinator SHALL set a `Strict-Transport-Security` response header on every response served over the HTTPS listener, with value `max-age=<maxAge>` plus `; includeSubDomains` when configured and `; preload` when configured. `maxAge` SHALL default to `31536000`. The coordinator SHALL NOT emit `Strict-Transport-Security` when serving plain HTTP. Config validation SHALL reject `preload: true` unless `includeSubDomains` is `true` and `maxAge` is at least `31536000`.

#### Scenario: HSTS header present on HTTPS responses
- **WHEN** TLS is configured and a client receives any response over `https`
- **THEN** the response SHALL include `Strict-Transport-Security: max-age=31536000` (plus `includeSubDomains`/`preload` directives if configured)

#### Scenario: No HSTS header over plain HTTP
- **WHEN** the coordinator is serving plain HTTP (no `tls` block)
- **THEN** responses SHALL NOT include a `Strict-Transport-Security` header

#### Scenario: HSTS can be suppressed
- **WHEN** `tls.hsts.enabled` is `false` and TLS is configured
- **THEN** responses over `https` SHALL NOT include a `Strict-Transport-Security` header

#### Scenario: preload requires includeSubDomains and a year-plus max-age
- **WHEN** `tls.hsts.preload` is `true` but `includeSubDomains` is not `true` or `maxAge` is below `31536000`
- **THEN** config validation SHALL fail with an error naming the preload prerequisites

### Requirement: Optional mutual TLS authenticates the connecting machine

When `tls.requireClientCert` is `true`, the `tls` block SHALL also provide `caFile`, and the coordinator SHALL construct the TLS server with `requestCert: true` and `rejectUnauthorized: true`. A connection presenting no client certificate, or one not signed by the configured CA, SHALL be rejected at the TLS layer before any HTTP handler runs. Mutual TLS SHALL layer on top of — never replace — the existing `Authorization: Bearer` / `X-Pane-Token` checks.

#### Scenario: Valid client certificate is admitted to the auth gate
- **WHEN** `requireClientCert` is true and a client connects presenting a certificate signed by the configured CA
- **THEN** the TLS handshake SHALL succeed and the request SHALL proceed to the normal bearer/pane-token auth gate

#### Scenario: Missing or untrusted client certificate is rejected at TLS
- **WHEN** `requireClientCert` is true and a client connects with no certificate, or one not signed by the configured CA
- **THEN** the connection SHALL be terminated at the TLS layer and no MCP tool, route handler, or auth gate SHALL be invoked

#### Scenario: requireClientCert without a CA is rejected by config validation
- **WHEN** `tls.requireClientCert` is `true` but `tls.caFile` is absent
- **THEN** config validation SHALL fail with an error stating that `caFile` is required for mutual TLS

### Requirement: Coordinator fails closed on a non-loopback plaintext bind

If the configured `host` is a non-loopback address AND no `tls` block is configured AND `allowInsecureNonLoopback` is not `true`, the coordinator SHALL refuse to start: it SHALL exit non-zero with an error explaining that binding a non-loopback interface without TLS would expose tokens and message bodies in cleartext. Loopback hosts (`127.0.0.0/8`, `::1`, `localhost`) are treated as loopback; any other host literal is treated as non-loopback. A configured hostname that is not a loopback literal SHALL be treated conservatively as non-loopback.

#### Scenario: Non-loopback plaintext bind is refused
- **WHEN** `host` is `0.0.0.0` (or any non-loopback address), no `tls` block is present, and `allowInsecureNonLoopback` is not set
- **THEN** the coordinator SHALL exit non-zero at startup with an error naming the insecure bind, and SHALL NOT begin listening

#### Scenario: Non-loopback with TLS starts normally
- **WHEN** `host` is non-loopback and a valid `tls` block is configured
- **THEN** the coordinator SHALL start and serve over TLS

#### Scenario: Explicit opt-out permits non-loopback plaintext
- **WHEN** `host` is non-loopback, no `tls` is configured, and `allowInsecureNonLoopback` is `true`
- **THEN** the coordinator SHALL start over plain HTTP and SHALL emit a startup warning that traffic is unencrypted

#### Scenario: Loopback plaintext is unaffected
- **WHEN** `host` is a loopback address and no `tls` is configured
- **THEN** the coordinator SHALL start over plain HTTP with no warning and no behaviour change

### Requirement: DNS-rebinding protection on the Streamable HTTP transport when an allowlist is configured

The coordinator SHALL accept an optional `allowedHosts` list in config. When `allowedHosts` is non-empty, the Streamable HTTP transport SHALL enable the SDK's `enableDnsRebindingProtection` with that list (and optional `allowedOrigins`), and a `POST /mcp` request whose `Host` (or `Origin`) header is outside the allowlist SHALL be rejected. The allowlist is operator-provided rather than auto-derived from the bind `host`: the bind address (often an IP or `0.0.0.0`) is not the hostname clients send in the `Host` header, so deriving the allowlist from it would reject legitimate traffic. When `allowedHosts` is absent, DNS-rebinding protection SHALL NOT be enabled (the SDK default).

#### Scenario: Disallowed Host header is rejected
- **WHEN** `allowedHosts` is configured and a `/mcp` request arrives with a `Host` header not in the allowlist
- **THEN** the coordinator SHALL reject the request and SHALL NOT construct or route to a transport for it

#### Scenario: Allowed Host header proceeds
- **WHEN** `allowedHosts` is configured and a `/mcp` request arrives with an allowlisted `Host` header
- **THEN** the request SHALL be handled normally

#### Scenario: No allowlist leaves protection off
- **WHEN** `allowedHosts` is absent from config
- **THEN** the Streamable HTTP transport SHALL NOT enable DNS-rebinding protection, and `/mcp` requests SHALL be handled regardless of `Host` header
