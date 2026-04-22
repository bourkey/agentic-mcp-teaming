## ADDED Requirements

### Requirement: Coordinator exposes a `report_tokens` MCP tool when metrics are enabled

When `peerBus.enabled: true` AND `peerBus.metrics.enabled: true` (default true when peer-bus is on) AND `report_tokens` is present in `toolAllowlist`, the coordinator SHALL register the `report_tokens` MCP tool. The tool signature:

```
report_tokens({
  sessionToken: string,
  delta: {
    input: non-negative integer,
    output: non-negative integer,
    cacheRead?: non-negative integer,
    cacheCreate?: non-negative integer
  },
  model: string (non-empty),
  reportedAt?: ISO-8601 UTC timestamp (optional; coordinator stamps if absent)
})
→ { ok: true, totalThisSession: { input, output, cacheRead, cacheCreate } }
```

Caller identity SHALL be derived from `sessionToken` via the existing constant-time authentication. Validation errors SHALL return the existing error-response shape with appropriate codes (`invalid_session_token` for auth failure; Zod path-based code mapping for validation failures). `report_tokens` SHALL update `lastSeenAt` on the authenticated caller like every other bus tool.

#### Scenario: Tool registered when enabled and allowed
- **WHEN** `peerBus.enabled: true`, `peerBus.metrics.enabled` defaults to true, and `toolAllowlist` contains `report_tokens`
- **THEN** an MCP `tools/list` request SHALL include `report_tokens`

#### Scenario: Tool NOT registered when metrics are disabled
- **WHEN** `peerBus.enabled: true` but `peerBus.metrics.enabled: false`
- **THEN** `report_tokens` SHALL NOT be registered, and a call to it SHALL return the SDK's unknown-tool error

#### Scenario: Authentication required
- **WHEN** `report_tokens` is called without `sessionToken` or with a token that does not authenticate
- **THEN** the tool SHALL return the standard `invalid_session_token` error response

#### Scenario: Happy-path report
- **WHEN** `report_tokens({ sessionToken: <valid>, delta: { input: 1000, output: 200 }, model: "claude-opus-4-7" })` is called
- **THEN** the coordinator SHALL append a line to `metrics.jsonl` with the delta and model, update the session's in-memory aggregate (`aggregate.input += 1000`, `aggregate.output += 200`), update `lastSeenAt`, and return `{ ok: true, totalThisSession: { input, output, cacheRead, cacheCreate } }`

#### Scenario: Negative delta rejected at validation
- **WHEN** `report_tokens` is called with `delta.input: -5`
- **THEN** the tool SHALL return an error response; no log append occurs and no aggregate mutation occurs

#### Scenario: Optional cache fields default to zero
- **WHEN** `report_tokens` is called with a delta containing only `input` and `output`
- **THEN** the coordinator SHALL treat missing `cacheRead`/`cacheCreate` as 0; the appended log line SHALL include them as 0; the aggregate SHALL NOT mutate in those fields

### Requirement: `metrics.jsonl` persists token-usage reports append-only

When metrics are enabled, the coordinator SHALL append each `report_tokens` call to `sessions/<coord-session>/metrics.jsonl` as a single JSON object per line, followed by a newline. The write SHALL be followed by an `fsync` before the tool returns. Lines SHALL have the shape:

```json
{
  "reportedAt": "2026-04-22T09:47:41.023Z",
  "session": "<caller name>",
  "delta": { "input": N, "output": N, "cacheRead": N, "cacheCreate": N },
  "model": "<model string>"
}
```

On startup, the coordinator SHALL read `metrics.jsonl` line-by-line and reconstruct per-session aggregates on the registry entries. Malformed lines SHALL be tolerated (logged at warning with line number / byte offset / first 120 bytes, skipped). There is no retention in v1; the log grows and operators rotate externally.

#### Scenario: Append-and-fsync discipline
- **WHEN** `report_tokens` is called successfully
- **THEN** the coordinator SHALL write the line to `metrics.jsonl` and fsync BEFORE returning the tool response

#### Scenario: Aggregate reconstruction on startup
- **WHEN** the coordinator starts with `peerBus.enabled: true`, `peerBus.metrics.enabled: true`, and `metrics.jsonl` contains lines for session `frontend` summing to `{ input: 5000, output: 800 }` across multiple reports
- **THEN** after startup, the in-memory aggregate for `frontend` SHALL reflect those sums

#### Scenario: Malformed metrics line tolerated
- **WHEN** `metrics.jsonl` contains a torn line that fails JSON parse
- **THEN** the coordinator SHALL log a warning with line number, byte offset, and first 120 bytes of the bad line, and continue reading; the aggregate SHALL be reconstructed from the valid lines

#### Scenario: Metrics file absent on first run
- **WHEN** the coordinator starts and `metrics.jsonl` does not exist
- **THEN** the coordinator SHALL treat the metrics log as empty and create it lazily on the first `report_tokens` call

### Requirement: Session registry entries carry in-memory token aggregates

Each session registry entry SHALL additionally carry a `tokenAggregate` field: `{ input, output, cacheRead, cacheCreate, lastReportAt? }`. On each successful `report_tokens` call for that session, the delta fields SHALL be added atomically (under the existing per-session mutex) to the aggregate, and `lastReportAt` SHALL be set to the report's `reportedAt` timestamp.

The aggregate SHALL NOT be persisted to `registry.json` (it is derived from `metrics.jsonl` and reconstructable on startup). Restart zeroes the in-memory aggregate until reconciliation replays `metrics.jsonl`.

#### Scenario: Aggregate updated on report
- **WHEN** a session already has aggregate `{ input: 100, output: 20 }` and receives a `report_tokens` with delta `{ input: 50, output: 10 }`
- **THEN** the aggregate SHALL become `{ input: 150, output: 30, cacheRead: 0, cacheCreate: 0 }` and `lastReportAt` SHALL equal the report's timestamp

#### Scenario: Aggregate NOT in registry.json
- **WHEN** the coordinator persists `registry.json`
- **THEN** the written file SHALL NOT contain a `tokenAggregate` field on any entry

#### Scenario: Aggregate rebuilt from metrics.jsonl on restart
- **WHEN** the coordinator restarts and `metrics.jsonl` contains N lines for session `frontend`
- **THEN** after startup reconciliation, `frontend`'s in-memory aggregate SHALL equal the sum of those N deltas (modulo any malformed lines that were tolerated + skipped)

### Requirement: Peer-bus config includes an optional metrics block

The `peerBus` Zod schema SHALL include an optional `metrics` sub-object with `enabled: boolean` (default: true when `peerBus.enabled` is true, false otherwise) and `metricsFile: string` (default `"metrics.jsonl"`). `.strict()` applies — unknown keys inside `peerBus.metrics` SHALL fail validation at load.

#### Scenario: Metrics defaults on with bus
- **WHEN** `mcp-config.json` contains `peerBus: { enabled: true }` with no explicit metrics block
- **THEN** `peerBus.metrics.enabled` SHALL default to `true` and `peerBus.metrics.metricsFile` SHALL default to `"metrics.jsonl"`

#### Scenario: Metrics can be opt-out explicitly
- **WHEN** `mcp-config.json` contains `peerBus: { enabled: true, metrics: { enabled: false } }`
- **THEN** the coordinator SHALL NOT register `report_tokens` and SHALL NOT create `metrics.jsonl`

#### Scenario: Unknown key inside metrics rejected
- **WHEN** `mcp-config.json` contains `peerBus.metrics.unknownField: "x"`
- **THEN** the coordinator SHALL exit on startup with a Zod validation error naming `unknownField`
