## 1. Server — thread X-Pane-Token from SSE connection into PeerBusContext

- [x] 1.1 Update `startHttpServer` in `src/server/index.ts`: change `serverFactory` type from `() => McpServer` to `(paneToken?: string) => McpServer`
- [x] 1.2 In the `GET /sse` handler, extract and normalize the header before passing to `serverFactory`:
  ```ts
  const raw = req.header('x-pane-token');
  const trimmed = raw?.trim();
  const byteLen = trimmed ? Buffer.byteLength(trimmed) : 0;
  const paneToken = byteLen >= 32 && byteLen <= 512 ? trimmed : undefined;
  ```
  Pass `paneToken` to `serverFactory(paneToken)`. (Combines original task 2.5 — empty-string coercion — with length-floor enforcement moved from Zod schema to connection layer.)
- [x] 1.3 Add `paneToken?: string` to `CoordinatorServerOptions` interface in `src/server/index.ts`
- [x] 1.4 Add `paneToken?: string` to `PeerBusContext` interface in `src/server/tools/peer-bus.ts`
- [x] 1.5 In `createCoordinatorServer`, pass `opts.paneToken` into the `peerCtx: PeerBusContext` object
- [x] 1.6 Update both `serve` and `start` subcommands in `src/index.ts`: change `makeServer` factory arrow to `(paneToken?: string) => createCoordinatorServer({ ...opts, paneToken })`. The spread creates a new options object per connection — `opts` itself is the static startup config with no `paneToken`.
- [x] 1.7 Update `SessionRegistry.register()` in `src/core/session-registry.ts`: change `paneToken` parameter from `string` to `string | undefined`. Make `paneTokenHash` storage conditional on `paneToken !== undefined`. When `paneToken` is `undefined`, use the existing `ZERO_SENTINEL` path for the constant-time comparison to avoid timing oracles on registry entry existence.

## 2. Server — simplify `register_session` tool schema

- [x] 2.1 Remove `paneToken` field from `RegisterSessionParams` Zod schema in `src/server/tools/peer-bus.ts`
- [x] 2.2 Update `registerSessionTool` handler:
  - (a) Add runtime guard at the top of the handler: if `ctx.paneToken === undefined` and the existing registry entry has a stored `paneTokenHash`, return `errorResult('invalid_pane_token_missing', ...)` immediately before calling `registry.register()`
  - (b) Remove the dead `if (root === 'paneToken') return 'invalid_pane_token_missing'` branch from `mapRegisterZodError`
  - (c) Read pane token from `ctx.paneToken` in the normal registration path (replaces `parsed.data.paneToken`)
- [x] 2.3 Update audit log entry in `registerSessionTool`: replace `paneToken: "<redacted>"` sourced from params with `paneToken: ctx.paneToken !== undefined ? "<redacted>" : undefined`
- [x] 2.4 Remove all remaining `priorSessionToken` references from `src/server/tools/peer-bus.ts`. Note: `invalid_prior_session_token_required` was specified but never shipped to source — verify with grep before assuming removal is needed; only documentation cleanup applies if absent.

## 3. Tests — update and add

- [x] 3.1 Update `tests/peer-bus-tools.test.ts`: remove `paneToken` from all `register_session` call fixtures; instead supply paneToken via a new `paneToken` field on the mock `PeerBusContext`
- [x] 3.2 Update `tests/wake-sender-influence.test.ts` and `tests/peer-bus-integration.test.ts`: remove `paneToken` from `register_session` call params; set `ctx.paneToken` on context instead
- [x] 3.3 Add test: `GET /sse` with `X-Pane-Token` header results in `PeerBusContext.paneToken` being set — verify via a `register_session` call that succeeds for a name with stored paneTokenHash
- [x] 3.4 Add test: `GET /sse` without `X-Pane-Token` results in `PeerBusContext.paneToken === undefined` — verify `register_session` on a name with stored paneTokenHash returns `invalid_pane_token_missing`
- [x] 3.5 Add test: `register_session` with `{ name, paneToken: "..." }` — Zod strips the unknown field silently; assert call succeeds and result contains a `sessionToken` (not an error). Confirm schema shape has no `paneToken` key.
- [x] 3.6 Add test: `GET /sse` with `X-Pane-Token` shorter than 32 bytes results in `paneToken === undefined` (length-floor enforcement)
- [x] 3.7 Add test: `POST /message` with `X-Pane-Token: <different-token>` header — assert tool handler still sees the paneToken from the originating `GET /sse` connection, not the POST header value
- [x] 3.8 Run `npm test` — all tests pass

## 4. Consumer — update `.mcp.json` and SKILL.md

- [ ] 4.1 Update `consumer-repo/.mcp.json`: add `"headers": { "X-Pane-Token": "${COORDINATOR_SESSION_TOKEN}" }` to the coordinator server entry
- [ ] 4.2 Update `consumer-repo/.claude/skills/peer-bus-session/SKILL.md`: change `register_session({ name: $COORDINATOR_SESSION_NAME, paneToken: $COORDINATOR_SESSION_TOKEN })` to `register_session({ name: $COORDINATOR_SESSION_NAME })` in all locations
- [ ] 4.3 Simplify recovery protocol in SKILL.md: remove `priorSessionToken` mentions; on `invalid_session_token`, call `register_session({ name })` (no token arg needed)
- [ ] 4.4 Update `consumer-repo/.codex/skills/peer-bus-session/SKILL.md` with same changes as 4.2–4.3
- [ ] 4.5 Replicate SKILL.md changes to worktrees: `consumer-repo-frontend`, `consumer-repo-backend`, `consumer-repo-misc`
- [ ] 4.6 Update `consumer-repo/.claude/commands/opsx/peer-inbox.md`: remove `paneToken` from any `register_session` references in the recovery path
- [ ] 4.7 Verify no remaining `paneToken` or `priorSessionToken` references in any consumer skill or command file

## 5. Commit and verify

- [ ] 5.1 Commit coordinator changes (`src/`, `tests/`) with message `feat(peer-bus): move pane token to X-Pane-Token connection header`
- [ ] 5.2 Confirm `npm test` passes after commit
- [ ] 5.3 Restart coordinator (`tmux kill-session -t coordinator && tmux new-session -d -s coordinator ...`)
- [ ] 5.4 Restart consumer tmux session via `start-team-session.sh` — confirm `COORDINATOR_SESSION_TOKEN` is in each pane env
- [ ] 5.5 Trigger a turn in a consumer pane — confirm `register_session({ name })` succeeds and sessionToken is returned (no transcript leak, no sandbox block)
- [ ] 5.6 Run `/clear` in a consumer pane; trigger another turn — confirm re-registration succeeds without operator intervention

## 6. cmux consumer token path (coordinator-repo deliverables)

- [x] 6.1 Update `.claude/skills/peer-bus-session/SKILL.md` (canonical): in the cmux setup guidance, document sourcing a stable per-pane `COORDINATOR_SESSION_TOKEN` via the generate-and-cache snippet (cache file `${XDG_STATE_HOME:-$HOME/.local/state}/agentic-mcp-teaming/tokens/<COORDINATOR_SESSION_NAME>`, generated with `openssl rand -base64 32`). State that the `X-Pane-Token` header is delivered identically to tmux and that without the token a cmux pane falls back to legacy unowned semantics
- [x] 6.2 Update `docs/peer-bus-runbook.md`: add a cmux token-setup section (generate-and-cache snippet + cmux `.mcp.json` headers block) and make the `COORDINATOR_SESSION_TOKEN` troubleshooting rows backend-aware (tmux launcher vs cmux profile snippet) rather than tmux-only

## 7. cmux consumer token path (external — consumer repo, not in this checkout)

- [ ] 7.1 Add the generate-and-cache `COORDINATOR_SESSION_TOKEN` snippet to each cmux pane startup profile / `.envrc` (alongside the existing `COORDINATOR_SESSION_NAME` export)
- [ ] 7.2 Add `"headers": { "X-Pane-Token": "${COORDINATOR_SESSION_TOKEN}" }` to the coordinator entry in the cmux consumer `.mcp.json`
- [ ] 7.3 Verify: restart a cmux pane and confirm the cached token is reused (`register_session({ name })` succeeds after coordinator restart / `/clear` without operator intervention); confirm two cmux panes get distinct tokens
