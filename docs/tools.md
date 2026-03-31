# MCP Tool Reference

The coordinator exposes up to 11 tools across three categories. Shared tools are accessible only to authorized MCP clients connected to the coordinator transport. Only tools listed in `mcp-config.json → toolAllowlist` are active.

---

## Shared tools

Standard filesystem tools and an optional execution tool. Paths are resolved relative to `mcp-config.json → rootDir`, and real filesystem targets are checked so both path traversal and symlink escapes are rejected.

---

### `read_file`

Read the contents of a file.

**Parameters**

| Name | Type | Required | Description |
|---|---|---|---|
| `path` | string | Yes | File path relative to `rootDir` |

**Returns** `{ content: [{ type: "text", text: "<file contents>" }] }`

**Example**
```json
{ "path": "src/schema.ts" }
```

---

### `write_file`

Write content to a file (creates or overwrites).

**Parameters**

| Name | Type | Required | Description |
|---|---|---|---|
| `path` | string | Yes | File path relative to `rootDir` |
| `content` | string | Yes | Content to write |

**Returns** `{ content: [{ type: "text", text: "Written: <path>" }] }`

**Example**
```json
{ "path": "output/result.md", "content": "# Result\n..." }
```

---

### `grep`

Search file contents for a pattern.

**Parameters**

| Name | Type | Required | Description |
|---|---|---|---|
| `pattern` | string | Yes | Search pattern (passed to `grep`) |
| `path` | string | No | File or directory to search (defaults to `rootDir`) |
| `recursive` | boolean | No | Search recursively (default: `true`) |

**Returns** Matching lines with line numbers, or `(no matches)` if none found.

**Example**
```json
{ "pattern": "ConsensusLoop", "path": "src/" }
```

---

### `glob`

List files matching a glob pattern.

**Parameters**

| Name | Type | Required | Description |
|---|---|---|---|
| `pattern` | string | Yes | Glob pattern (e.g. `src/**/*.ts`) |

**Returns** Newline-separated list of matching paths relative to `rootDir`, or `(no matches)`.

**Example**
```json
{ "pattern": "tests/**/*.test.ts" }
```

---

### `bash` (optional)

Execute a shell command. Timeout: 30 seconds. `cwd` is set to `rootDir`. This tool is disabled unless `bash` is explicitly present in `toolAllowlist`.

**Parameters**

| Name | Type | Required | Description |
|---|---|---|---|
| `command` | string | Yes | Shell command to execute |

**Returns** Combined stdout and stderr.

**Example**
```json
{ "command": "npm test -- --reporter=verbose" }
```

---

## Agent trigger tools

These tools invoke registered AI agents and external CLI reviewers. `invoke_agent` drives the core consensus workflow; `invoke_reviewer` dispatches an external CLI-based reviewer and parses its structured output.

`AgentMessage` schema:
```json
{
  "version": "1",
  "role": "<agentId>",
  "phase": "proposal" | "design" | "spec" | "task" | "implementation" | "review",
  "action": "approve" | "request-changes" | "block" | "comment" | "implement" | "submit",
  "content": "<agent response text>",
  "artifactId": "<artifact identifier>",
  "round": 0
}
```

`role` is an open string — any registered agent ID (e.g. `"architect"`, `"security"`, `"implementer"`) is valid.

---

### `invoke_agent`

Invoke a named agent from the registry with a prompt and return an `AgentMessage`. The tool routes the call to the correct CLI based on the agent entry in `mcp-config.json`. Spawn guardrails are enforced before each invocation (unknown-agent check, depth limit, concurrent cap, session budget).

**Parameters**

| Name | Type | Required | Description |
|---|---|---|---|
| `agentId` | string | Yes | Registered agent ID (must exist in `mcp-config.json → agents`) |
| `prompt` | string | Yes | Prompt to send to the agent |
| `artifactId` | string | Yes | Artifact identifier (recorded in the returned message) |
| `round` | number (int ≥ 0) | Yes | Current review round number |
| `context` | string | No | Additional context prepended to the prompt |
| `snapshotContext` | object (Record\<string, string\>) | No | Key-value map of tool name → output; injected as labeled context blocks before the prompt |
| `invocationContext` | object | No | Call-tree context: `{ invocationId, parentInvocationId, depth }` |

**Returns** `{ content: [{ type: "text", text: "<AgentMessage JSON>" }] }`

**Errors** — Returns an error if `agentId` is not in the registry, or if any spawn guardrail rejects the invocation.

**Example**
```json
{
  "agentId": "architect",
  "prompt": "Review this proposal and approve or request changes.",
  "artifactId": "proposal",
  "round": 0
}
```

**Example with snapshot context**
```json
{
  "agentId": "implementer",
  "prompt": "Review this design document.",
  "artifactId": "design",
  "round": 0,
  "snapshotContext": {
    "read_file:design.md": "## Context\n..."
  }
}
```

---

### `invoke_reviewer`

Invoke an external CLI-based reviewer (e.g. `codex`) with a structured prompt and parse its JSON findings output. Unlike `invoke_agent`, this tool is intended for lightweight pass/fail reviewers that emit `ReviewerFindings` JSON rather than `AgentMessage` JSON. Only reviewers with a `cli` field in the `reviewers` block of `mcp-config.json` can be called through this tool.

**Parameters**

| Name | Type | Required | Description |
|---|---|---|---|
| `reviewerId` | string | Yes | Reviewer ID (must exist in `mcp-config.json → reviewers` and have a `cli` field) |
| `stage` | `"spec"` \| `"code"` | Yes | Review stage; the reviewer must be configured for this stage |
| `artifactContent` | string | Yes | Content to review (artifact text or change description) |

**Returns** `ReviewerFindings` JSON:
```json
{
  "reviewerId": "codex-peer",
  "findings": [
    {
      "finding": "Missing input validation",
      "severity": "major",
      "proposedFix": "Add Zod schema for request body",
      "location": "src/server/index.ts:42"
    }
  ],
  "timedOut": false
}
```

If the reviewer process times out, `findings` is `[]` and `timedOut` is `true`. A warning is recorded in the audit log.

**Errors** — Returns an error if `reviewerId` is not in the registry, the reviewer has no `cli` field, or the reviewer is not configured for the requested `stage`.

**Example**
```json
{
  "reviewerId": "codex-peer",
  "stage": "code",
  "artifactContent": "## Changes\nsrc/server/index.ts — added invoke_reviewer handler\n..."
}
```

---

## Workflow tools

Drive and inspect the coordination workflow. These tools are called by the coordinator's internal workflow loop and can also be called by a human CLI client connected to the MCP server.

---

### `submit_for_consensus`

Submit an artifact to the consensus loop. Runs the full review cycle (up to `maxRounds`) and returns the outcome.

**Parameters**

| Name | Type | Required | Description |
|---|---|---|---|
| `artifactId` | string | Yes | Identifier for the artifact being reviewed |
| `content` | string | Yes | Full artifact content to review |

**Returns**
```json
{
  "outcome": "consensus-reached" | "human-approved" | "aborted",
  "summary": "<human-readable outcome description>",
  "rounds": 1
}
```

**Example**
```json
{ "artifactId": "proposal", "content": "## Why\n..." }
```

---

### `advance_phase`

Advance the workflow to the next phase. Requires the specified artifact to have a terminal outcome (`consensus-reached` or `human-approved`).

**Parameters**

| Name | Type | Required | Description |
|---|---|---|---|
| `artifactId` | string | Yes | The artifact whose outcome authorises the transition |

**Returns**
```json
{ "newPhase": "design" }
```

**Errors** — throws if the artifact outcome is `pending` or `aborted`.

**Example**
```json
{ "artifactId": "proposal" }
```

---

### `get_session_state`

Return the current session state as JSON.

**Parameters** — none

**Returns** Full `SessionState` object. See [session-format.md](session-format.md) for the schema.

---

### `resolve_checkpoint`

Record a human decision at a checkpoint. Unblocks (`proceed`) or halts (`abort`) the workflow.

**Parameters**

| Name | Type | Required | Description |
|---|---|---|---|
| `decision` | `"proceed"` \| `"abort"` | Yes | Human decision |
| `artifactId` | string | No | Artifact to mark with the resulting outcome |
| `reason` | string | No | Optional reason (recorded in the audit log) |

**Returns**
```json
{ "resolved": true, "outcome": "human-approved" }
```

**Errors** — throws with the abort reason if `decision` is `"abort"`.

**Example**
```json
{ "decision": "proceed", "artifactId": "design", "reason": "Approved after offline discussion" }
```
