# Session Format

Each session creates a directory at `sessions/<session-id>/` containing three artefacts:

```
sessions/<session-id>/
  state.json          # Current session state (read/write)
  audit.log           # Append-only NDJSON event log
  snapshots/          # One JSON file per review snapshot
    <snapshot-id>.json
```

---

## state.json

A single JSON object written atomically after every state change. Fields:

| Field | Type | Description |
|---|---|---|
| `sessionId` | string | UUID identifying this session |
| `currentPhase` | `"proposal"` \| `"design"` \| `"spec"` \| `"task"` \| `"implementation"` \| `"review"` | The active workflow phase |
| `artifactOutcomes` | `Record<string, ArtifactOutcome>` | Outcome per artifact ID; see values below |
| `snapshotIds` | `Record<string, string>` | Maps artifact ID → latest snapshot ID for that artifact |
| `revisionRounds` | `Record<string, number>` | How many revision rounds have occurred per artifact |
| `taskAssignments` | `TaskAssignment[]` | Task-to-agent assignments produced during the task phase |
| `implBranch` | string (optional) | Name of the Git session branch created for implementation |
| `taskWorktrees` | `Record<string, TaskWorktree>` | Per-task Git worktree metadata |
| `checkpointPending` | boolean | `true` while the workflow is paused at a human checkpoint |
| `spawnStats` | `{ activeCount: number, sessionTotal: number }` | Live spawn tracker counters; `activeCount` is the number of currently running agent invocations, `sessionTotal` is the all-time count for this session |
| `startedAt` | ISO 8601 string | Session creation timestamp |
| `updatedAt` | ISO 8601 string | Last state write timestamp |

### ArtifactOutcome values

| Value | Meaning |
|---|---|
| `pending` | Review not yet complete |
| `consensus-reached` | Both agents approved the same artifact revision |
| `human-approved` | Human operator explicitly advanced the workflow |
| `aborted` | Workflow halted by human |

### TaskAssignment

```json
{
  "taskId": "1.1",
  "description": "Initialize Node.js/TypeScript project",
  "primaryAgent": "implementer",
  "reviewingAgent": "architect"
}
```

`primaryAgent` and `reviewingAgent` are agent IDs from the registry (e.g. `"implementer"`, `"architect"`), not fixed CLI names.

### TaskWorktree

```json
{
  "branch": "task/1-1",
  "worktreePath": "/abs/path/to/.worktrees/task-1-1",
  "baseCommit": "abc123",
  "status": "implementing" | "reviewing" | "approved" | "integrated" | "failed"
}
```

### Example state.json

```json
{
  "sessionId": "a1b2c3d4-...",
  "currentPhase": "design",
  "artifactOutcomes": {
    "proposal": "consensus-reached"
  },
  "snapshotIds": {
    "proposal": "e5f6g7h8-..."
  },
  "revisionRounds": {
    "proposal": 0
  },
  "taskAssignments": [],
  "taskWorktrees": {},
  "checkpointPending": false,
  "spawnStats": { "activeCount": 0, "sessionTotal": 4 },
  "startedAt": "2026-03-26T10:00:00.000Z",
  "updatedAt": "2026-03-26T10:04:22.317Z"
}
```

---

## audit.log

Newline-delimited JSON (NDJSON). Every line is a self-contained JSON object. The log is append-only — existing entries are never modified.

All entries share a `timestamp` (ISO 8601) and `type` field. Additional fields vary by type.

### Entry types

#### `session_start`
Emitted when the coordinator starts.
```json
{ "timestamp": "...", "type": "session_start", "sessionId": "...", "dryRun": false, "startPhase": "proposal" }
```

#### `session_complete`
Emitted when all phases complete successfully.
```json
{ "timestamp": "...", "type": "session_complete", "sessionId": "..." }
```

#### `session_error`
Emitted on an unhandled error.
```json
{ "timestamp": "...", "type": "session_error", "sessionId": "...", "error": "Error message" }
```

#### `tool_call`
Emitted for every shared tool invocation (`read_file`, `write_file`, `grep`, `glob`, `bash`).
```json
{
  "timestamp": "...", "type": "tool_call",
  "tool": "read_file", "params": { "path": "src/schema.ts" },
  "resultLength": 1842, "sessionId": "..."
}
```

#### `agent_invocation`
Emitted after every `invoke_agent` call.
```json
{
  "timestamp": "...", "type": "agent_invocation",
  "agentId": "architect", "sessionId": "...", "phase": "proposal",
  "artifactId": "proposal", "round": 0,
  "invocationId": "inv-abc123",
  "parentInvocationId": null,
  "depth": 1,
  "response": { "action": "approve", "contentLength": 312 }
}
```

#### `consensus_start`
Emitted when `submit_for_consensus` is called for an artifact.
```json
{ "timestamp": "...", "type": "consensus_start", "artifactId": "proposal", "phase": "proposal", "sessionId": "..." }
```

#### `review_round_start`
Emitted at the beginning of each review round.
```json
{ "timestamp": "...", "type": "review_round_start", "artifactId": "proposal", "round": 0, "snapshotId": "...", "sessionId": "..." }
```

#### `review_round_responses`
Emitted after all reviewer agents have responded in a round.
```json
{
  "timestamp": "...", "type": "review_round_responses",
  "artifactId": "proposal", "round": 0,
  "responses": [
    { "agentId": "architect", "action": "approve" },
    { "agentId": "security", "action": "request-changes" }
  ],
  "sessionId": "..."
}
```

#### `consensus_end`
Emitted when the consensus loop concludes.
```json
{ "timestamp": "...", "type": "consensus_end", "artifactId": "proposal", "outcome": "consensus-reached", "rounds": 1, "sessionId": "..." }
```

#### `spawn_rejected`
Emitted when `invoke_agent` is rejected by a spawn guardrail.
```json
{
  "timestamp": "...", "type": "spawn_rejected",
  "agentId": "architect", "reason": "depth-limit-exceeded",
  "depth": 3, "sessionId": "..."
}
```

Possible `reason` values: `"unknown-agent"`, `"depth-limit-exceeded"`, `"concurrent-limit-reached"`, `"session-budget-exhausted"`.

#### `spawn_budget_warning`
Emitted when the session invocation count reaches 80% of `maxSessionInvocations`.
```json
{
  "timestamp": "...", "type": "spawn_budget_warning",
  "sessionTotal": 40, "maxSessionInvocations": 50, "sessionId": "..."
}
```

#### `block_escalation`
Emitted when an agent returns `block`.
```json
{ "timestamp": "...", "type": "block_escalation", "artifactId": "design", "blocker": "codex", "reason": "Fundamental flaw in...", "sessionId": "..." }
```

#### `revision_cap_reached`
Emitted when the maximum revision rounds are exhausted.
```json
{ "timestamp": "...", "type": "revision_cap_reached", "artifactId": "design", "rounds": 3, "sessionId": "..." }
```

#### `revision_submitted`
Emitted when the originating agent submits a revised artifact.
```json
{ "timestamp": "...", "type": "revision_submitted", "artifactId": "design", "round": 1, "contentLength": 4200, "sessionId": "..." }
```

#### `phase_advance`
Emitted when `advance_phase` transitions the workflow.
```json
{ "timestamp": "...", "type": "phase_advance", "fromPhase": "proposal", "toPhase": "design", "triggeredBy": "proposal", "sessionId": "..." }
```

#### `checkpoint_presented`
Emitted each time a human checkpoint is shown.
```json
{ "timestamp": "...", "type": "checkpoint_presented", "artifactId": "design", "reason": "...", "decision": "proceed", "sessionId": "..." }
```

#### `checkpoint_resolved`
Emitted when `resolve_checkpoint` is called.
```json
{ "timestamp": "...", "type": "checkpoint_resolved", "decision": "proceed", "artifactId": "design", "outcome": "human-approved", "sessionId": "..." }
```

#### `task_start` / `task_integrated` / `task_blocked`
Emitted during the implementation phase for each task.
```json
{ "timestamp": "...", "type": "task_start", "taskId": "1.1", "primaryAgent": "implementer", "branch": "task/1-1", "baseCommit": "abc123", "sessionId": "..." }
{ "timestamp": "...", "type": "task_integrated", "taskId": "1.1", "branch": "task/1-1", "sessionId": "..." }
{ "timestamp": "...", "type": "task_blocked", "taskId": "1.1", "reason": "...", "sessionId": "..." }
```

---

## Resuming an interrupted session

1. Find the session ID from a previous run — it is printed at startup and visible in `sessions/` directory names.

2. Pass it to the `start` command:
   ```bash
   npm start -- start --session <session-id>
   ```

3. The coordinator loads `sessions/<session-id>/state.json` and resumes from `currentPhase`. Artifacts with outcome `consensus-reached` or `human-approved` are not re-reviewed.

4. If `checkpointPending` is `true` in state, the workflow was paused at a human checkpoint. The coordinator will prompt for a `proceed` or `abort` decision before continuing.

### What determines resume behaviour

| state.json field | Effect on resume |
|---|---|
| `currentPhase` | Coordinator jumps to this phase |
| `artifactOutcomes[id]` = `consensus-reached` / `human-approved` | Artifact is skipped (already resolved) |
| `artifactOutcomes[id]` = `pending` | Artifact is re-submitted to the consensus loop |
| `checkpointPending` = `true` | Coordinator prompts for human decision before proceeding |
| `taskWorktrees[id].status` = `integrated` | Task is skipped during implementation |
| `taskWorktrees[id].status` = `failed` / `implementing` / `reviewing` | Task is retried from the beginning |
