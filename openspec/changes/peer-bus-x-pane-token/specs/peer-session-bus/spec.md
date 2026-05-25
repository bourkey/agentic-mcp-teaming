## MODIFIED Requirements

### Requirement: `register_session` input schema contains only `name` and optional `autoWakeKey`

The `register_session` tool input schema SHALL contain exactly: `name` (string, matching `SESSION_NAME_REGEX`) and optional `autoWakeKey` (string | null | undefined). The `paneToken` and `priorSessionToken` fields SHALL NOT be present in the schema. Callers that previously supplied `paneToken` as a tool argument SHALL move to the `X-Pane-Token` connection header. Callers that supplied `priorSessionToken` SHALL use the paneToken mechanism instead (already superseded).

#### Scenario: Schema strips unknown fields silently
- **WHEN** a caller sends `register_session({ name: "claude-main", paneToken: "..." })`
- **THEN** Zod SHALL strip the unknown `paneToken` field and the call SHALL proceed normally using `PeerBusContext.paneToken` for credential checking. No error is returned for the unknown field. This allows a zero-downtime migration: consumers running an old SKILL.md that still passes `paneToken` as a tool arg continue to register successfully once the coordinator is updated (the arg is discarded; real auth comes from the `X-Pane-Token` header).

#### Scenario: Schema accepts name-only call
- **WHEN** a caller sends `register_session({ name: "claude-main" })`
- **THEN** the tool SHALL proceed to registry lookup using `PeerBusContext.paneToken` for credential checking

## REMOVED Requirements

### Requirement: `register_session` accepts `priorSessionToken` for session recovery

**Reason:** Superseded by the `X-Pane-Token` connection header mechanism. Pane identity is now proven at connection time via a stable credential from the env, not via a rotating session token passed as a tool argument. The `invalid_prior_session_token_required` error code is retired.

**Migration:** Consumers that relied on `priorSessionToken` rotation SHALL set `COORDINATOR_SESSION_TOKEN` in the pane environment and configure `"X-Pane-Token": "${COORDINATOR_SESSION_TOKEN}"` in the coordinator `.mcp.json` headers block. The SKILL.md recovery protocol simplifies to: on `invalid_session_token`, call `register_session({ name })` once (no token argument required) to obtain a new session token.

**Upgrade trap:** Consumers that have NOT yet updated their `.mcp.json` to include the `X-Pane-Token` header will receive `invalid_pane_token_missing` on any session name that has an existing `paneTokenHash` (i.e. was previously registered via the header mechanism). The only remediation is to add the `"X-Pane-Token": "${COORDINATOR_SESSION_TOKEN}"` entry to the coordinator `.mcp.json` headers block. Alternatively, operators can clear the registry (restart the coordinator) to reset all `paneTokenHash` entries and allow legacy re-registration.

**Note on retired error code:** `invalid_prior_session_token_required` is retired. This code was specified but never shipped to source. No code removal is required in `src/server/tools/peer-bus.ts` for this specific code; only documentation cleanup applies.
