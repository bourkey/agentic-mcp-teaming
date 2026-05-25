## ADDED Requirements

### Requirement: `coordinator` binary exposes client subcommands

The `coordinator` CLI SHALL expose the following subcommands alongside the existing `serve`, `start`, and `status`:

- `coordinator register [--name <name>] [--prior-token <token>] [--coordinator-url <url>] [--quiet]`
- `coordinator send --to <name> --kind <kind> --body <value> [--reply-to <uuid>] [--name <name>]`
- `coordinator read [--wrap-for-prompt] [--name <name>]`
- `coordinator report-tokens --input <n> --output <n> [--cache-read <n>] [--cache-create <n>] --model <m> [--name <name>]`
- `coordinator deregister [--name <name>]`

Each subcommand SHALL default `--name` from `$COORDINATOR_SESSION_NAME` and the coordinator URL from `$COORDINATOR_URL`, falling back to `http://127.0.0.1:3100/sse`. The transport auth token SHALL be read from the env var named in `authTokenEnvVar` (default `$COORDINATOR_AUTH_TOKEN`).

#### Scenario: Subcommand listed in --help
- **WHEN** `coordinator --help` is invoked
- **THEN** the output SHALL list `register`, `send`, `read`, `report-tokens`, and `deregister` alongside the existing server subcommands, each with a short description

#### Scenario: Missing --name AND COORDINATOR_SESSION_NAME
- **WHEN** any authenticated subcommand is invoked without `--name` and without `$COORDINATOR_SESSION_NAME` set
- **THEN** the subcommand SHALL exit with a non-zero status and a clear error on stderr naming the missing value

#### Scenario: Explicit flag overrides env
- **WHEN** a subcommand is invoked with `--name frontend` AND `$COORDINATOR_SESSION_NAME=backend` is set
- **THEN** the subcommand SHALL operate on `frontend`; the env var SHALL be ignored

### Requirement: Token cache persists session tokens per name

Each successful `register` invocation SHALL write a cache file at `$XDG_RUNTIME_DIR/coordinator/<name>.token` (falling back to `$TMPDIR/coordinator/<name>.token`, and finally `/tmp/coordinator/<name>.token`) with mode 0o600. The file SHALL contain:

```json
{
  "name": "<name>",
  "coordinatorUrl": "<url>",
  "sessionToken": "<token>",
  "registeredAt": "<iso-8601>",
  "writtenBy": <pid>
}
```

The parent directory SHALL be created with mode 0o700 if absent. The file SHALL be rewritten atomically (write `<path>.tmp` then `rename`) on every rotation. `deregister` SHALL unlink the cache file; it SHALL NOT contact the coordinator.

#### Scenario: Register creates cache file
- **WHEN** `coordinator register --name frontend` succeeds
- **THEN** `$XDG_RUNTIME_DIR/coordinator/frontend.token` (or the platform-appropriate fallback) SHALL exist with mode 0o600 and contain the token payload

#### Scenario: Cache file owner-only readable
- **WHEN** the cache file is written
- **THEN** its permissions SHALL be 0o600; group and other SHALL have no access

#### Scenario: Atomic rotation
- **WHEN** a subcommand rotates the token after `invalid_session_token`
- **THEN** the file SHALL be written to `<path>.tmp` then renamed over the live path; at no point SHALL a partially-written file be observable

#### Scenario: Deregister unlinks cache file
- **WHEN** `coordinator deregister --name frontend` is invoked
- **THEN** the cache file SHALL be removed; the coordinator SHALL NOT be contacted; the subcommand SHALL succeed silently even if no cache file existed

### Requirement: Authenticated subcommands implement stale-token recovery

`send`, `read`, and `report-tokens` SHALL implement the client recovery protocol specified in the `peer-session-bus` capability: on receiving `invalid_session_token`, call `register_session` once (without `priorSessionToken`) to rotate, persist the new token to the cache file, retry the original call once with the new token. If the recovery registration fails with `invalid_prior_session_token_required` (another process holds the name), the subcommand SHALL surface an operator-intervention message on stderr and exit non-zero. If the retry also fails with `invalid_session_token`, the subcommand SHALL surface a race-condition message on stderr and exit non-zero.

Recovery SHALL NOT be applied more than once per subcommand invocation. Recovery SHALL NOT be applied to `register` itself (which is idempotent).

#### Scenario: Transparent recovery on stale token
- **WHEN** `coordinator send --to b --kind chat --body hi` is invoked with a stale token in the cache (e.g. coordinator restarted, wiping token hashes)
- **THEN** the subcommand SHALL call `register_session`, update the cache, retry `send_message`, and exit 0 with the resulting messageId on stdout

#### Scenario: Operator intervention required when name is owned
- **WHEN** the cache has a stale token and another client has registered under the same name since restart
- **THEN** the recovery registration SHALL receive `invalid_prior_session_token_required`; the subcommand SHALL exit non-zero with a stderr message naming the session and directing the operator to remove the cache file manually or pick a different name

### Requirement: `send` body accepts JSON or raw text

The `--body` flag SHALL accept a single string argument. If that string parses as valid JSON, the parsed JSON value SHALL be the body sent to the coordinator. If JSON parse fails, the raw string SHALL be the body.

#### Scenario: JSON body
- **WHEN** `coordinator send ... --kind workflow-event --body '{"event":"worktree-ready","change":"x"}'` is invoked
- **THEN** the body in the bus envelope SHALL be a JSON object `{"event":"worktree-ready","change":"x"}` (not a string)

#### Scenario: Plain text body
- **WHEN** `coordinator send ... --kind chat --body 'hello world'` is invoked
- **THEN** the body in the bus envelope SHALL be the string `"hello world"`

#### Scenario: Body reading from stdin via --body -
- **WHEN** `coordinator send ... --body -` is invoked with content piped on stdin
- **THEN** the subcommand SHALL read the body from stdin before calling `send_message`

### Requirement: `read` supports JSON and prompt-wrapped output shapes

Default (no `--wrap-for-prompt`): `read` SHALL emit a JSON array to stdout, each element `{ messageId, wrapped }`, where `wrapped` is the server-rendered envelope string. With `--wrap-for-prompt`: `read` SHALL emit a single `<peer-inbox>` block containing all envelopes concatenated by newline, suitable for prepending to a model prompt. Empty mailbox with `--wrap-for-prompt` SHALL emit an empty string (no block at all).

#### Scenario: JSON output
- **WHEN** `coordinator read` is invoked with two unread envelopes
- **THEN** stdout SHALL be a JSON array of length 2 with `messageId` and `wrapped` fields

#### Scenario: Prompt-wrapped output
- **WHEN** `coordinator read --wrap-for-prompt` is invoked with two unread envelopes
- **THEN** stdout SHALL be a single `<peer-inbox>...</peer-inbox>` block containing both envelopes

#### Scenario: Empty mailbox with --wrap-for-prompt emits nothing
- **WHEN** `coordinator read --wrap-for-prompt` is invoked and there are no unread envelopes
- **THEN** stdout SHALL be empty (no `<peer-inbox>` block)

### Requirement: Coordinator binary is both server and client

Documentation SHALL describe the `coordinator` binary as a dual-role server+client tool: operators running the coordinator use `serve`/`start`/`status`; consumers integrating with the bus use `register`/`send`/`read`/`report-tokens`/`deregister`. Both sets of subcommands share one binary, one version, one release.

#### Scenario: README documents both sides
- **WHEN** the README is rendered
- **THEN** the "Running the coordinator" section SHALL describe the server subcommands; a new "Integration guide" section SHALL describe the client subcommands with a worked example of a downstream project adopting the bus
