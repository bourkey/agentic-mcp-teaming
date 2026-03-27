## Context

The current coordinator hardcodes two agents as named function slots (`invokeClaude`, `invokeCodex`) and two MCP tools (`invoke_claude`, `invoke_codex`). `AgentRole` is a fixed enum. The consensus evaluator takes exactly two `AgentMessage` arguments. Adding any third agent requires changes across five files. Sub-agent calls — when Claude or Codex internally spawns further agents — are invisible to the coordinator and produce no audit trail.

The refactor generalises the agent layer to N named agents from a config registry, replaces the two tools with one generic `invoke_agent` tool, and introduces coordinator-enforced guardrails to prevent runaway spawning while keeping full observability of every invocation.

## Goals / Non-Goals

**Goals:**
- Any number of named agents declarable in `mcp-config.json` — zero source changes to add a specialist
- Single `invoke_agent(agentId, ...)` MCP tool; all agent invocations — coordinator-initiated and agent-initiated — flow through it
- Unanimous consensus: any dissent (block or unresolved request-changes) escalates to human; no majority override
- Multi-agent feedback aggregated into a single unified revision request
- Full call-tree audit trail with parent/child invocation IDs
- Hard spawning guardrails: registry check, depth limit, concurrent sub-invocation cap, session budget
- Parallel first-pass review via `Promise.all`

**Non-Goals:**
- Dynamic agent registration at runtime (registry is static, loaded at startup)
- Agent authentication or sandboxing beyond what the OS provides for CLI subprocesses
- Cross-session invocation tracking
- Weighted voting or role-priority consensus policies in v1 (unanimous only)

## Decisions

### Decision 1: Single `invoke_agent` tool with agent ID parameter

**Chosen:** One MCP tool `invoke_agent(agentId, prompt, context, invocationContext)` replaces `invoke_claude` and `invoke_codex`. The coordinator looks up `agentId` in the registry, injects the agent's `specialty` into the system prompt, and spawns the CLI. Agents with `allowSubInvocation: true` are launched with coordinator transport details so they can make authenticated MCP calls back to the parent coordinator during their turn.

**Rationale:** Scales to N agents without new tools or source changes. The MCP tool name is stable; agents are added by editing config only. External MCP clients that were calling `invoke_claude`/`invoke_codex` must migrate — this is an explicit breaking change, documented in the proposal.

**Alternative considered:** Keep `invoke_claude`/`invoke_codex` and add `invoke_agent` as a third tool alongside them — rejected because it splits the invocation path and makes the guardrails harder to enforce consistently.

### Decision 2: Unanimous consensus with immediate human escalation on any dissent

**Chosen:** `evaluateConsensus(msgs[])` returns `consensus-reached` only when every agent approves. Any `block` triggers an immediate human checkpoint. Any `request-changes` after `maxRounds` triggers a human checkpoint. Between rounds, all change requests are aggregated and passed back as a unified prompt to a configured revising agent.

**Rationale:** The user's explicit requirement: "consensus should be mutual." Majority voting would allow a security specialist's block to be overridden, which defeats the purpose of having a specialist. Unanimous is conservative but correct for a system where specialists are added precisely because their domain matters.

**Feedback aggregation format:**
```
## Revision Requested — Round <n>

### From: architect
<content>

### From: security
<content>

### From: tester
<content>
```
Passed as a single `context` block to the next `invoke_agent` call for the configured revising agent.

Authoring/revision ownership:
- Each agent entry declares capability flags: `canReview`, `canRevise`, `canImplement`, `allowSubInvocation`
- Consensus rounds run only against agents where `canReview: true`
- Revision prompts are routed only to agents where `canRevise: true`
- Implementation task primaries are chosen only from agents where `canImplement: true`
- If no eligible revising or implementing agent exists, session initialization fails with a descriptive configuration error

### Decision 3: Spawning guardrails enforced at the `invoke_agent` MCP tool boundary

**Chosen:** All four guardrails are checked inside the `invoke_agent` tool handler before the CLI subprocess is spawned. Violations return an MCP error response immediately and log a `spawn_rejected` audit entry. Depth violations also trigger a human checkpoint.

**Guardrail defaults (all configurable in `mcp-config.json`):**

| Guardrail | Default | Rationale |
|---|---|---|
| Registry check | required | Prevents arbitrary CLI execution |
| `maxSpawnDepth` | 2 | coordinator→agent→sub-agent; no deeper |
| `maxConcurrentSubInvocations` | 5 | Prevents delegated fan-out from exhausting resources |
| `maxSessionInvocations` | 50 | Circuit breaker for runaway loops |

**Rationale:** Enforcing at the tool boundary means the guardrails are centralized. The concurrent cap applies only to agent-initiated sub-invocations, not to the coordinator's own first-pass review batch, so a registry larger than five reviewers does not self-deadlock by default.

### Decision 4: Call tree tracked via `InvocationContext` passed through `invoke_agent`

**Chosen:** Every `invoke_agent` call carries an `InvocationContext` with `invocationId` (new UUID), `parentInvocationId` (null for coordinator-initiated), and `depth`. The coordinator increments depth, assigns a new UUID, and records both IDs in the audit log entry. Session state tracks `spawnStats.activeCount` (current delegated in-flight count) and `spawnStats.sessionTotal` (session budget counter).

```
invocationId:       uuid-A   parentInvocationId: null     depth: 1
  └─ invocationId:  uuid-B   parentInvocationId: uuid-A   depth: 2
```

**Rationale:** The VS Code extension (`vscode-coordinator-ui`) can reconstruct the call tree from the audit log and render sub-agent turns as nested children in the conversation view. No extra API needed.

Transport model for agent-initiated calls:
- Agents with `allowSubInvocation: true` are launched with coordinator MCP connection details injected via environment variables and prompt context
- The coordinator also injects the current `invocationContext` so the child can pass `parentInvocationId` back on any delegated `invoke_agent` call
- Agents without `allowSubInvocation` receive no transport details and therefore cannot invoke child agents even if they attempt to

### Decision 5: Parallel first-pass review with `Promise.all`

**Chosen:** The consensus loop invokes all reviewer agents concurrently:
```typescript
const msgs = await Promise.all(
  reviewers.map(agentId => invokeAgentTool(ctx, { agentId, prompt, ... }))
);
```
Independent first-pass review semantics are preserved — all agents see the same snapshot and no agent sees another's response before submitting their own.

**Alternative considered:** Sequential invocation — rejected because there is no ordering dependency in the first-pass phase, and parallel execution reduces wall-clock latency proportionally to the number of agents.

### Decision 6: `mcp-config.json` agent registry shape

```json
{
  "agents": {
    "architect":  { "cli": "claude", "specialty": "system design and architecture", "canReview": true, "canRevise": true, "canImplement": false, "allowSubInvocation": true },
    "security":   { "cli": "claude", "specialty": "security review and threat modelling", "canReview": true, "canRevise": false, "canImplement": false, "allowSubInvocation": false },
    "implementer":{ "cli": "codex",  "specialty": "code generation and refactoring", "canReview": true, "canRevise": true, "canImplement": true, "allowSubInvocation": true },
    "tester":     { "cli": "codex",  "specialty": "test writing and coverage", "canReview": true, "canRevise": false, "canImplement": true, "allowSubInvocation": false }
  },
  "consensus": {
    "maxRounds": 3
  },
  "spawning": {
    "maxDepth": 2,
    "maxConcurrentSubInvocations": 5,
    "maxSessionInvocations": 50
  }
}
```

`allowSubInvocation: false` means that agent may not call `invoke_agent` itself — specialists like `security` are leaf nodes that review but do not delegate. Capability flags also prevent reviewer-only specialists from being selected as revisers or implementers.

## Risks / Trade-offs

- **Breaking change for external MCP clients** → Mitigation: documented explicitly in proposal; `invoke_claude`/`invoke_codex` tool names removed with no compatibility shim.
- **Unanimous consensus is slower** → Mitigation: parallel invocation offsets the per-round latency; human checkpoint at cap keeps sessions from dragging on indefinitely.
- **Agent feedback aggregation may produce very long revision prompts** → Mitigation: coordinator truncates each agent's feedback block to a configurable limit (default: 2KB per agent) before aggregating.
- **`Promise.all` failure if one agent CLI errors** → Mitigation: wrap each invocation in a per-agent try/catch; a CLI error for one agent is treated as a `block` from that agent, triggering the human checkpoint path.
- **Session invocation budget too low for complex workflows** → Mitigation: `maxSessionInvocations` is configurable; default of 50 is intentionally conservative and surfaced as a warning before the hard limit.
- **Delegated CLI must be able to reach the coordinator transport** → Mitigation: coordinator injects connection details only for agents with `allowSubInvocation: true`; if transport injection is unavailable for a given CLI wrapper, that agent must be configured with `allowSubInvocation: false`.

## Migration Plan

1. Update `mcp-config.json` to new agent registry shape (migrate `claude`/`codex` entries to named agents).
2. Update any external MCP clients calling `invoke_claude`/`invoke_codex` to call `invoke_agent` with the appropriate `agentId`.
3. Deploy updated coordinator — new `invoke_agent` tool registered, old tools removed.
4. Existing sessions in `sessions/` continue to load because `SessionManager.load()` backfills missing `spawnStats` and any other new optional state fields before Zod validation.

Rollback: revert coordinator source and `mcp-config.json`; existing sessions unaffected.

## Open Questions

- Should `allowSubInvocation` default to `true` or `false` for agents not explicitly configured? (Safer to default `false`.)
- Should the feedback truncation limit per agent be configurable per-agent or only globally?
- Should the VS Code extension render a depth indicator (indentation or tree lines) in the conversation view for sub-agent turns?
