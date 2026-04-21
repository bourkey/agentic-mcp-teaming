# CLAUDE.md — agentic-mcp-teaming

## Build & test

```bash
npm run build        # tsc compile
npm test             # vitest (111 tests)
npm run build && npm test  # full verification pass
```

All changes must pass `npm test` before being considered complete.

## Architecture overview

- **`src/config.ts`** — Zod schema for `mcp-config.json`. All config parsing goes here; never read raw JSON elsewhere.
- **`src/server/index.ts`** — MCP coordinator server (SSE/HTTP transport). Tool registration lives here. Import tool handlers from `src/server/tools/`.
- **`src/server/tools/agents.ts`** — `invokeAgentTool` and `invokeReviewerTool`. Agent spawning guardrails enforced here.
- **`src/server/tools/filesystem.ts`** — `read_file`, `write_file`, `grep`, `glob`. All paths resolved through `safeReadPath`/`assertWithinRoot`.
- **`src/server/tools/workflow.ts`** — Consensus loop, phase advancement, checkpoint resolution.
- **`src/session/`** — Session state, audit logger, registry, snapshot store.

## Reviewer system

Reviewers are configured in `mcp-config.json → reviewers`. Two types:
- **No `cli` field** → dispatched as Claude sub-agents (Agent tool in the `run-review-gate` skill)
- **Has `cli` field** → invoked via the `invoke_reviewer` MCP tool using `execFile`

The `run-review-gate` skill (`.claude/skills/run-review-gate/SKILL.md`) handles both gates (`stage: spec` and `stage: code`). It dispatches all reviewers in parallel, runs a synthesis agent, auto-applies uncontested findings, and escalates contested ones.

## Security constraints

- **`bash` tool is opt-in** — never add it to `toolAllowlist` by default; it allows arbitrary shell execution
- **`execFile` only** — never use `exec` or `spawn` with `shell: true` for agent/reviewer invocation
- **`assertWithinRoot`** — all filesystem tool paths must pass this check; it rejects traversal and symlink escapes. Note: currently permits `rootDir` itself — treat as a known gap
- **Auth token** — compared with `timingSafeEqual`; never use `===` for token comparison
- **CLI config** — reviewer `cli` field is a free string today; validate against an allowlist if expanding to untrusted config sources

## Peer session bus

- **`execFile` only** for the tmux notifier — no `exec`, no `spawn { shell: true }`, no string interpolation into shell commands
- **Session tokens are never logged and never persisted** — the registry stores only `sha256(token)`. If you add logging anywhere in the peer-bus path, ensure tokens are redacted to `"<redacted>"`; never interpolate a raw token into a Zod error message, a thrown error, or a log statement
- **Compile-time constants**: `PEER_BUS_MAX_BODY_BYTES = 65536`, `PEER_BUS_MAX_UNREAD = 10000`, `PEER_BUS_MAX_RESPONSE_BYTES = 1048576`. Do NOT thread these through config
- **Registry uses `Map<string, Entry>`** — never a plain object. Prototype-pollution resistance depends on this
- **Timestamps** are always UTC with trailing `Z`. Comparisons use `Date.parse()` — never raw string compare
- **Authentication iterates every entry** with `timingSafeEqual` against a 32-byte zero sentinel for empty-tokenHash entries. No early return, no short-circuit — those are timing oracles
- **Envelope rendering** strips XML 1.0 illegal control chars before XML-escaping both body and attribute values — this is the only place peer content gets serialised to an envelope
- **POSIX filesystem required** for `coordinator.lock` (`O_EXCL|O_CREAT` must be atomic). NFS-pre-v3 and some overlay filesystems are unsupported

## Testing conventions

- Use `vi.mock("child_process")` at module level (top of test file) for any test that exercises `invokeReviewerTool`. Late mocking (`vi.doMock` inside tests) does not work because `execFileAsync` is bound at import time.
- Use `vi.mocked(execFile).mockImplementation(...)` with the typed callback pattern — see `tests/reviewer-tools.test.ts` for the reference implementation.
- Integration/unit boundary: filesystem tool tests use real temp files; agent/reviewer tests mock `child_process`.

## Conventions

- No hardcoded strings for config values — use `McpConfig` fields
- Delete old code when replacing; no compatibility shims
- Comments only where logic is non-obvious
- `execFile` (not `exec`) for all subprocess calls — arguments passed as array, never interpolated into a shell string
