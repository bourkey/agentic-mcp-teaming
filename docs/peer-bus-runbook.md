# Peer session bus — operator runbook

Operational reference for running the opsx workflow with the peer-session-bus
coordinator. Cross-linked from the **Peer session bus (experimental)** section
of `CLAUDE.md`. Design decisions and capability contract are in
`openspec/changes/archive/2026-04-21-peer-session-bus/`.

---

## 1. Start the coordinator

The coordinator is this repo:

```bash
# Start per the README (typical command):
npm start -- serve
```

The coordinator binds to `localhost:3100/sse` and writes to
`sessions/<uuid>/messages.jsonl` on first message.

**File-mode expectations.** The coordinator SHOULD create
`sessions/<uuid>/` mode `0700` and `messages.jsonl` mode `0600`. If you
are on a shared workstation, verify this before starting the launcher:

```bash
stat -f %Sp sessions/*/
stat -f %Sp sessions/*/messages.jsonl
```

The launcher's bus window is omitted (with a visible warning in the startup
summary) if either is world-readable.

## 2. Start the tmux session

From the main checkout of `generic-consumer`:

```bash
your tmux launcher
```

Optional flags:

- `--session <uuid>` — required when multiple coordinator sessions are
  present under `sessions/`. The UUID must match the coordinator's
  actual session directory name.
- `--dry-run` — print the launch plan and exit without spawning tmux.

The startup summary line tells you the state in one line:

```
Opened: main,frontend,backend,misc. Skipped (no worktree): <none>. Bus: on.
```

The resulting tmux session has one `opsx` window containing one pane per
opened worktree area, arranged in a tiled layout (2×2 when all four areas
are present). The `bus` tail window is a separate window — one
`Ctrl-b n/p` away from `opsx`. Worktree areas are panes, not windows;
the `bus` remains a window.

**Operator tip:** `Ctrl-b z` zooms the active pane to full-window size
and toggles back — useful when working in a single worktree for an
extended task.

## 2a. Start the cmux session (macOS only)

cmux is a native macOS terminal with per-pane `CMUX_SURFACE_ID` and
`CMUX_WORKSPACE_ID` env vars. To use the peer bus from cmux:

**1. Configure `mcp-config.json`:**

```json
"peerBus": {
  "enabled": true,
  "backend": "cmux",
  "notifier": { "cmuxEnabled": true, "displayMessageFormat": "peer-bus: from {from} kind {kind}" },
  "autoWake": { "allowedCommands": { "claude-inbox": "/opsx:peer-inbox" }, "debounceMs": 1000 }
}
```

**2. Set `COORDINATOR_SESSION_NAME` in each cmux pane's startup profile.**

Add to your cmux workspace profile, `.envrc`, or shell config:

```bash
# Option A: Derive from cmux workspace title (requires jq)
export COORDINATOR_SESSION_NAME=$(cmux current-workspace --json 2>/dev/null | jq -r '.title // empty')

# Option B: Hardcode per pane
export COORDINATOR_SESSION_NAME=claude-main
```

Name each workspace after its peer identity: `claude-main`, `claude-frontend`,
`claude-backend`, or `claude-misc`. The name must match `^[a-z0-9][a-z0-9-]{0,62}$`.

**3. Set a stable `COORDINATOR_SESSION_TOKEN` in the same profile.**

cmux has no launcher to generate the pane credential (the tmux side gets it
from `start-team-session.sh`), so each cmux pane sources its own. Add a
generate-and-cache snippet after the name export — generated once, reused on
every restart:

```bash
TOK_DIR="${XDG_STATE_HOME:-$HOME/.local/state}/agentic-mcp-teaming/tokens"
mkdir -p "$TOK_DIR"
TOK_FILE="$TOK_DIR/$COORDINATOR_SESSION_NAME"
[ -s "$TOK_FILE" ] || openssl rand -base64 32 | tr -d '\n' > "$TOK_FILE"
export COORDINATOR_SESSION_TOKEN="$(cat "$TOK_FILE")"
```

Then add the header to the cmux consumer `.mcp.json` coordinator entry (same
as the tmux consumer):

```json
"coordinator": {
  "url": "http://localhost:3100/sse",
  "headers": { "X-Pane-Token": "${COORDINATOR_SESSION_TOKEN}" }
}
```

Caching by `$COORDINATOR_SESSION_NAME` keeps the token stable across coordinator
restarts and `/clear` (re-registration stays self-healing) and unique per pane
(no cross-pane re-claim). Without it a cmux pane still registers, but only as
legacy unowned semantics — it loses cross-restart re-claim protection.

**4. Restart the coordinator and launch Claude Code in each pane.**

`CMUX_SURFACE_ID` and `CMUX_WORKSPACE_ID` are auto-injected by cmux.
The `peer-bus-session` skill detects cmux context automatically and
passes them to `register_session`. No further manual configuration needed.

**Auto-wake note:** Auto-wake is currently **disabled** for cmux panes —
`wake_suppressed { reason: "probe_disabled" }` appears in the audit log
for every message to an opted-in recipient. This is expected. The probe
will be enabled when cmux exposes a `pane_current_command` API
(upstream issues #152/#153). All other peer bus features (notifier, badge,
messaging) work normally.

**Kill-switch:** `export PEER_BUS_DISABLED=1` in the pane environment disables all bus features for that pane.

## 3. Configure transport-level auth (optional)

If the coordinator enforces `Authorization: Bearer <token>` on the MCP
endpoint, add the header via a **local-scope** MCP server with Claude Code's
CLI (writes to `~/.claude.json`, per-operator, never committed). Local scope
**replaces** project scope, so the override MUST also include the
`X-Pane-Token` header — otherwise pane authentication fails because the
project-scope `X-Pane-Token` header is dropped:

```bash
claude mcp add --transport http coordinator --scope local http://localhost:3100/sse \
  --header 'Authorization: Bearer ${COORDINATOR_AUTH_TOKEN}' \
  --header 'X-Pane-Token: ${COORDINATOR_SESSION_TOKEN}'
```

**Mandatory single quotes** around the `--header` value — double quotes
would shell-expand `${COORDINATOR_AUTH_TOKEN}` at add-time and persist the
plaintext token on disk. Claude Code expands the reference at connection
time (documented at
<https://code.claude.com/docs/en/mcp.md#environment-variable-expansion-in-mcpjson>),
so only the literal `${COORDINATOR_AUTH_TOKEN}` placeholder is stored in
`~/.claude.json`.

Key properties of this mechanism:

- **Local scope beats project scope** for identical server names
  (<https://code.claude.com/docs/en/mcp.md#scope-hierarchy-and-precedence>),
  so the local-scope entry cleanly overrides the committed `.mcp.json`
  entry without modifying or duplicating the committed file for operators
  who do not need auth.
- **Claude Code keys local scope by the MAIN CHECKOUT path** (derivable
  via `realpath "$(git rev-parse --git-common-dir)/.."`), not by the
  current worktree path. A **single** `claude mcp add --scope local`
  invocation from any worktree therefore covers all sibling worktrees
  (`main`, `frontend`, `backend`, `misc`) — operators do NOT repeat the
  invocation per worktree. Empirical evidence: the existing `stitch`
  entry is keyed under the main checkout path yet resolves correctly
  from every worktree.
- **Do NOT sync `~/.claude.json`** via dotfile repos, iCloud, MDM, or
  similar — the file contains local MCP credentials for every project
  you've configured. On multi-user hosts, expect `0600` perms on the
  file; the file-permission guidance in §7 applies.
- **`COORDINATOR_AUTH_TOKEN` must be exported** in the shell environment
  when Claude Code starts; otherwise the header expands to `Bearer `
  (empty) and the coordinator returns 401. The token env var is set per
  shell and never committed:

```bash
export COORDINATOR_AUTH_TOKEN='…'
```

If the coordinator does not enforce transport auth, leave the committed
`.mcp.json` as-is and do NOT set the env var.

### Cleaning up a pre-fix auth override

If you previously added a `mcpServers.coordinator.headers` block to
`.claude/settings.local.json` under the pre-fix override path, delete that
block — Claude Code was already ignoring it (`settings.local.json` does not
support `mcpServers`). Then re-apply the header via a single
`claude mcp add --scope local` invocation from any worktree as documented
above (main-checkout-keyed — covers all sibling worktrees; do NOT repeat
per worktree).

### Rotating or removing the local-scope auth override

To rotate or remove the token:

```bash
# Remove once from any worktree (main-checkout-keyed — clears the shared entry):
claude mcp remove coordinator --scope local

# If rotating: re-export the new token, then re-add with single quotes.
# Both headers are mandatory — local scope replaces project scope, so the
# X-Pane-Token header from .mcp.json is otherwise dropped:
export COORDINATOR_AUTH_TOKEN='<rotated-value>'
claude mcp add --transport http coordinator --scope local http://localhost:3100/sse \
  --header 'Authorization: Bearer ${COORDINATOR_AUTH_TOKEN}' \
  --header 'X-Pane-Token: ${COORDINATOR_SESSION_TOKEN}'

# Restart every Claude Code pane so the new config is picked up:
tmux kill-session -t claude && your tmux launcher
```

Verify the token is not persisted in expanded form (token-unset-guarded —
without the guard, an unset var makes `grep -F --` match every line):

```bash
test -n "$COORDINATOR_AUTH_TOKEN" && grep -F -- "$COORDINATOR_AUTH_TOKEN" ~/.claude.json | wc -l
```

MUST return `0`.

If the rotation was triggered by a suspected token leak, also scan shell
history by eye (do NOT pipe through `grep -F -- "$SOME_VAR"` with a
possibly-unset var — same false-positive class as the `~/.claude.json`
check):

```bash
grep -E 'Bearer [A-Za-z0-9._=+/-]+' ~/.zsh_history ~/.bash_history 2>/dev/null | head -20
```

Review the output manually. Any hit where the string after `Bearer` is a
plausible token (rather than the literal `${COORDINATOR_AUTH_TOKEN}`
placeholder) indicates a shell-history leak — record and rotate again if
necessary.

### Diagnosing `coordinator not available on startup`

When a pane prints `peer-bus: coordinator not available on startup — bus
features disabled`, the message is the same for several distinct root
causes: the coordinator is offline; `.mcp.json` is malformed;
`COORDINATOR_SESSION_TOKEN` (X-Pane-Token) was unset when the pane
started; or (for auth-required coordinators) `COORDINATOR_AUTH_TOKEN`
was unset. The following probe distinguishes them:

```bash
# With both tokens exported (empty is allowed for unauthed/no-pane-token branches):
curl -sS --max-time 5 -o /dev/null -w '%{http_code}\n' \
  -H "Authorization: Bearer $COORDINATOR_AUTH_TOKEN" \
  -H "X-Pane-Token: $COORDINATOR_SESSION_TOKEN" \
  http://localhost:3100/sse
```

| Result | Meaning | Next step |
|---|---|---|
| `200` / 2xx | Coordinator listening, both auth paths fine | Re-check `claude mcp get coordinator` output — likely `.mcp.json` parse error or a stale override |
| `401` (both tokens exported, non-empty) | Coordinator listening, one or both rejected | Rotate/re-export the failing token. To isolate which: re-run the probe omitting one `-H` at a time |
| `401` (`COORDINATOR_SESSION_TOKEN` unset or empty) | Coordinator listening, X-Pane-Token header was empty/missing | Export `COORDINATOR_SESSION_TOKEN` (tmux: set by `start-team-session.sh`; cmux: by the generate-and-cache snippet in §2a), then restart panes |
| `401` (`COORDINATOR_AUTH_TOKEN` unset or empty) | Coordinator listening, Claude Code sent `Bearer ` (empty) | Export `COORDINATOR_AUTH_TOKEN`, restart panes |
| `000` / `curl: (7)` | Coordinator not listening | Start the coordinator (see §1) |
| `000` after 5-second hang | `--max-time` fired before headers — inconclusive | Rerun with `-m 10`, or check the coordinator log |

The probe establishes the coordinator's raw HTTP auth behaviour. It does
NOT by itself prove Claude Code expanded `${COORDINATOR_AUTH_TOKEN}` or
`${COORDINATOR_SESSION_TOKEN}` at connection time — the definitive
end-to-end signal for that is the `peer-bus-session` skill emitting
`Inbox: N new messages` after a pane restart with both tokens exported.

## 3a. TLS and cross-machine deployment

The coordinator defaults to plain HTTP on `127.0.0.1`. To host it and connect
agents from other machines, enable TLS — otherwise the auth token,
`X-Pane-Token`, and message bodies cross the network in cleartext. Binding a
non-loopback `host` over plain HTTP is **refused at startup** for this reason.

**1. Provision certificates.** Server cert + key (and, for mutual TLS, a CA plus
one client cert per agent machine). Protect the private key:

```bash
chmod 600 /etc/coordinator/tls/server.key
```

**2. Configure `mcp-config.json`** (see the README "TLS and cross-machine
deployment" example): set `host`, the `tls` block (`certFile`/`keyFile`,
optional `caFile` + `requireClientCert`, optional `hsts`), and `allowedHosts`
(the exact `Host` values clients send — `/mcp` rejects others with `403`).
Restart the coordinator; cert rotation is a restart (certs are read at startup).

**3. Point agents at `https://`** in their `.mcp.json`, and make each client
**trust the server CA** — `export NODE_EXTRA_CA_CERTS=/path/ca.crt` for Node-based
MCP clients, or install the CA in the system trust store. Do **not** disable
certificate verification; there is no insecure flag, by design. For mutual TLS,
install the per-machine client cert where the client reads it.

**HSTS on a `.dev` domain.** The whole `.dev` TLD is HSTS-preloaded, so browsers
force HTTPS for any `*.dev` regardless. The coordinator's `Strict-Transport-Security`
header (default on with TLS) formalises that; `includeSubDomains`/`preload` stay
off unless you opt in — turning them on asserts a subtree/preload-list policy
across sibling subdomains, which is slow to reverse.

**Reverse-proxy alternative.** If you prefer ACME-managed certs, run Caddy/nginx
terminating TLS in front of the loopback coordinator (`proxy_pass`/`reverse_proxy`
to `127.0.0.1:3100`) and keep the coordinator on plain HTTP loopback. Set
`allowInsecureNonLoopback` only if the coordinator itself must bind a non-loopback
interface behind the proxy on a trusted network.

## 4. Toggle the coordinator's tmux notifier

Default recommendation in `CLAUDE.md` is to leave this **disabled** — the
`bus` tail window is the primary signal channel. If you prefer tmux
banners over the tail view (and want to close the bus window to reduce
redundancy), flip the coordinator-side config:

```yaml
# in mcp-config.json
peerBus:
  notifier:
    tmuxEnabled: true
```

Restart the coordinator after changing. Record the current observed
default in your change's `tasks.md §1.3` per the
Operational-Prerequisites pattern.

## 5. Inspect messages.jsonl safely

```bash
# Tail the bus log manually (same command the bus window uses):
tail -F sessions/<uuid>/messages.jsonl \
  | jq -Rr --unbuffered 'fromjson? // empty' | cat -v
```

`jq -Rr 'fromjson? // empty'` silently drops malformed lines so the tail
survives partial writes and log rotation. `cat -v` defangs terminal
control sequences. Do NOT `cat` or `less` the raw file — a crafted body
could rewrite your terminal.

## 6. Recovery procedures

### Re-registration after compaction or pane restart

**Behavior.** Re-registration is self-healing. The coordinator stores
`sha256($COORDINATOR_SESSION_TOKEN)` as the durable identity credential
for each pane name. When a pane re-registers, the X-Pane-Token header on
the SSE handshake carries `$COORDINATOR_SESSION_TOKEN` (tmux: stable for
the lifetime of a tmux session; cmux: stable via the per-name cached token
from the §2a snippet), and the coordinator overwrites the stale entry and
issues a fresh `sessionToken`. No operator intervention is required.

Pane names are client-scoped. Claude uses `claude-main`,
`claude-frontend`, `claude-backend`, `claude-misc`; Codex uses
`codex-main`, `codex-frontend`, `codex-backend`, `codex-misc`. A Claude
pane and a Codex pane do not collide with each other unless they are
misconfigured to share the same scoped name.

**When re-registration fails (`invalid_pane_token_missing`).** This
error means the coordinator did not see a valid `X-Pane-Token` header on
the SSE handshake. After the X-Pane-Token migration, the pane credential
is sent as an HTTP header (configured in `.mcp.json`'s
`mcpServers.coordinator.headers`), not as a `register_session` argument.
Diagnose and fix in order:

1. Confirm `$COORDINATOR_SESSION_TOKEN` is exported in the pane shell:
   `printenv COORDINATOR_SESSION_TOKEN | wc -c` should return a non-zero
   count. If empty: on tmux, the launcher did not export the token (the
   worktree may have failed the bus-artifact check, or the pane was started
   outside the launcher); on cmux, the generate-and-cache snippet (§2a) is
   missing from the pane profile.
2. Confirm `.mcp.json` carries the X-Pane-Token header:
   `claude mcp get coordinator` should show `headers.X-Pane-Token` with
   value `${COORDINATOR_SESSION_TOKEN}` (literal placeholder, not
   expanded). If missing, `.mcp.json` is stale — pull `main` and restart
   the pane.
3. If both pass and registration still fails, confirm the Claude Code
   version supports header env-var interpolation (see
   <https://code.claude.com/docs/en/mcp.md#environment-variable-expansion-in-mcpjson>).
   Older versions may not interpolate, sending the literal `${...}`
   placeholder as the header value.
4. If the operator has a local-scope auth override, verify it carries
   BOTH `Authorization` and `X-Pane-Token` headers (per §3 above) — local
   scope replaces project scope, so a pre-migration local override that
   carries only `Authorization` will silently drop `X-Pane-Token`. Re-run
   `claude mcp add --scope local ...` with both `--header` flags, then
   restart panes via your tmux launcher
   so panes receive a freshly-generated `COORDINATOR_SESSION_TOKEN`.

### `mailbox_full` on a specific area

**Cause.** That area pane has 10 000 unread envelopes. Reasons: pane
never read its mailbox (not yet registered, Claude Code closed), or an
upstream bug is filling the mailbox in a tight loop.

**Resolution.** Re-attach (or restart) Claude Code in that pane. The
next turn's `read_messages` drains the mailbox. If draining is slow
because `hasMore` keeps triggering, the drain caps at 5 same-turn calls
then surfaces "partial — N+ messages still queued" — re-trigger by
typing another prompt in that pane.

### Emergency kill-switch

Set `PEER_BUS_DISABLED=1` in a pane's environment to silence all bus
features on the next Claude Code turn without restarting the pane:

```bash
export PEER_BUS_DISABLED=1
# or, for a running tmux session:
tmux setenv -t claude PEER_BUS_DISABLED 1
```

The startup skill prints one informational line (`peer-bus:
PEER_BUS_DISABLED set — bus features off`) on the next turn and skips
all MCP calls thereafter. Re-enable by unsetting the env var and
restarting Claude Code in that pane.

Use this during a live incident where bus activity is misbehaving
(noisy summaries, unexpected events, performance regression). Reverting
the PR is the durable fix; the kill-switch is the bridge.

### Worker-pane autonomy kill-switch

Set `OPSX_AUTONOMY_DISABLED=1` in a worker pane's environment to halt
autonomous pipeline progression without affecting bus features:

```bash
export OPSX_AUTONOMY_DISABLED=1
# or, for a running tmux session:
tmux setenv -t claude OPSX_AUTONOMY_DISABLED 1
```

When set, every autonomy-aware skill (`/opsx:auto-advance`, `/opsx:apply`,
`/opsx:review`, `/opsx:archive`) prints one line to stderr and exits without
chaining to the next skill:

```
opsx-<skill>: OPSX_AUTONOMY_DISABLED set — <autonomy halted | not chaining to ...>
```

This kill-switch halts only autonomous chaining. The skills themselves still
run normally when invoked directly by the operator. The bus remains fully
operational — existing event emission and mailbox drain continue as usual.

Use this when a worker pane is advancing through phases faster than you want
to review, or when you need to step in manually at a specific phase.
Re-enable by unsetting the env var; no pane restart required.

### 6.2 Idle-halt banner

| Symptom | Cause & remedy |
|---|---|
| `opsx-auto-advance: idle 4h+ in phase=<phase> — autonomy halted. Re-run /loop /opsx:auto-advance to resume.` on stderr | Worker pane has been waiting on `claude-main` or the operator for over 4 hours in a waiting phase (`worktree-ready`, `paused-awaiting-response`, or `merged-or-awaiting-merge`). Intentional autonomy stop — re-run `/loop /opsx:auto-advance` in that pane to resume. The 4-hour clock restarts from zero on each resume. |

## 7. File-permission expectations for shared workstations

The launcher's file-permission check is a shared-workstation safeguard:

- `sessions/<uuid>/` SHOULD be mode `0700` (or at least the world-read
  bit must be zero).
- `messages.jsonl` SHOULD be mode `0600` (or at least the world-read
  bit must be zero).

Standard single-user macOS and Linux setups with default umask 022 will
produce `0755`/`0644` files — **these will trigger the launcher's world-
readable check and disable the bus window.** On a trusted single-user
workstation, tighten the coordinator's file creation by setting `umask
077` in its startup environment, or post-create with `chmod 0700` /
`chmod 0600`.

## 8. Secret hygiene (paper-trail expectations)

The capability spec forbids emit bodies from carrying:

- API tokens, bearer tokens, session credentials.
- URLs with embedded credentials (`https://oauth:<token>@github.com/...`).
- Raw `git diff` output, file contents, operator free-text.

Consumer-side detection drops such messages automatically. If you
observe `peer-bus: dropped message with suspected secret from <sender>`
in any pane's output: treat it as an incident. Identify the offending
emit point, fix the producer, and rotate any credential that may have
been in the body.

## 9. Auth token paper trail

When `COORDINATOR_AUTH_TOKEN` is introduced, rotated, or revoked, record
the scope / expiry / principal in the change's GitHub issue comment
thread per the CLAUDE.md Operational-Prerequisites rule. The token
value itself MUST NEVER leave the operator's shell / secret store.

## 10. Normative references

- Capability spec: `openspec/changes/archive/2026-04-21-peer-session-bus/`.
- Design decisions: `openspec/changes/archive/2026-04-21-peer-session-bus/`.
- Startup skill: `.claude/skills/peer-bus-session/SKILL.md`.
- Peer-session-bus contract: `openspec/changes/archive/2026-04-21-peer-session-bus/`.
