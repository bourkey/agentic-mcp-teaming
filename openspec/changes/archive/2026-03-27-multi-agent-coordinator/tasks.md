## 1. Schema and Config

- [x]1.1 Update `AgentRole` in `src/schema.ts` from a fixed enum to `z.string()` (open agent ID); update `TaskAssignment` fields accordingly
- [x]1.2 Add `InvocationContext` Zod type to `src/schema.ts`: `{ invocationId: string, parentInvocationId: string | null, depth: number }`
- [x]1.3 Update `McpConfig` in `src/config.ts`: replace `agents.claude`/`agents.codex` with a `z.record` agent map; each entry has `cli`, optional `specialty`, `canReview`, `canRevise`, `canImplement`, and optional `allowSubInvocation` (default `false`)
- [x]1.4 Add `consensus: { maxRounds: number }` block to `McpConfig` schema
- [x]1.5 Add `spawning: { maxDepth, maxConcurrentSubInvocations, maxSessionInvocations }` block to `McpConfig` schema with documented defaults
- [x]1.6 Update `mcp-config.json` to new shape: migrate `claude`/`codex` entries to named agents (`architect`, `implementer`), add `consensus` and `spawning` blocks
- [x]1.7 Write unit tests for updated config schema: valid registry, missing CLI field, empty registry, missing reviser/implementer error, defaults for omitted spawning fields

## 2. Agent Registry

- [x]2.1 Implement `AgentRegistry` class: loads from parsed `McpConfig.agents`; exposes `get(agentId)`, `all()`, `allowsSubInvocation(agentId)`, `reviewers()`, `revisers()`, and `implementers()`
- [x]2.2 Add startup registry validation in `src/index.ts`: for each entry call `which <cli>` (or equivalent) and exit with a descriptive error if any CLI is missing
- [x]2.3 Write unit tests for `AgentRegistry`: known/unknown agent lookup, sub-invocation permission check, reviewer/reviser/implementer filtering, empty registry error

## 3. `invoke_agent` MCP Tool

- [x]3.1 Rewrite `src/server/tools/agents.ts`: remove `invokeClaudeTool`/`invokeCodexTool`; implement `invokeAgentTool(ctx, { agentId, prompt, context, snapshotContext, invocationContext })`
- [x]3.2 `invokeAgentTool` looks up agent in registry, injects specialty into system prompt, conditionally injects coordinator transport details for `allowSubInvocation` agents, builds full prompt, spawns CLI subprocess, parses `AgentMessage`, logs audit entry with full `InvocationContext`
- [x]3.3 Update `AgentToolsContext` interface: remove `claudeCli`/`codexCli`; add `registry: AgentRegistry` and `spawnTracker: SpawnTracker`
- [x]3.4 Update `src/server/index.ts`: remove `invoke_claude`/`invoke_codex` registrations; register single `invoke_agent` tool with `agentId`, `prompt`, `context?`, `snapshotContext?`, `invocationContext?` params
- [x]3.5 Write unit tests for `invokeAgentTool`: specialty injection, correct CLI path used, transport details injected only for delegation-enabled agents, audit entry fields, parse fallback on malformed output

## 4. Spawn Controls

- [x]4.1 Implement `SpawnTracker` class: tracks delegated `activeCount`, `sessionTotal`, per-chain depth via `parentInvocationId` lookup; exposes `check(invocationContext, agentId, registry, source) → SpawnCheckResult`
- [x]4.2 `SpawnCheckResult` carries `allowed: boolean`, `reason?: string`, `shouldEscalate: boolean`
- [x]4.3 Wire `SpawnTracker.check()` into `invokeAgentTool` before CLI spawn: on rejection, log `spawn_rejected` entry, return MCP error, call `resolve_checkpoint` if `shouldEscalate`
- [x]4.4 Implement budget warning: when `sessionTotal` crosses 80% of `maxSessionInvocations`, log `spawn_budget_warning` entry
- [x]4.5 Update `SessionManager` to persist `spawnStats` (`activeCount`, `sessionTotal`) in `state.json` so resume picks up correct counters; backfill defaults on load for pre-change sessions
- [x]4.6 Write unit tests for `SpawnTracker`: unknown agent rejection, depth limit at exactly max, delegated concurrent cap, coordinator review batch exempt from delegated cap, budget exhaustion at exactly max, warning at 80%, `shouldEscalate` correct per reason

## 5. N-Agent Consensus Loop

- [x]5.1 Refactor `ConsensusLoop` in `src/core/consensus.ts`: replace `invokeClaude`/`invokeCodex` function slots with `reviewerAgentIds: string[]` and a single `invokeAgent: AgentInvokeFn` injectable
- [x]5.2 Replace sequential invocation with `Promise.all(reviewerAgentIds.map(id => invokeAgent(...)))` for first-pass review
- [x]5.3 Update `evaluateConsensus` to accept `AgentMessage[]`; return `consensus-reached` only if all approve; any block → `"block"`; any request-changes → `"needs-revision"`
- [x]5.4 Implement `aggregateFeedback(msgs: AgentMessage[])`: filter to `request-changes` messages, truncate each to 2048 chars, produce `## Revision Requested — Round <n>\n\n### From: <agentId>\n<content>` document
- [x]5.5 Pass aggregated feedback as `context` in the revision `invoke_agent` call to a configured revising agent
- [x]5.6 Treat any `invoke_agent` error/timeout during a review round as a `block` from that agent (wrap in try/catch in the `Promise.all` map)
- [x]5.7 Update `ConsensusLoop` constructor to accept `reviewerAgentIds` instead of two named inject fns; update all callers in `src/phases/*` and `src/server/index.ts`
- [x]5.8 Write unit tests: all-approve → consensus-reached; one block → immediate escalation; mixed request-changes → aggregated feedback content; cap reached → escalation; CLI error → treated as block

## 6. Phase and Implementation Updates

- [x]6.1 Update `src/phases/tasks.ts`: `parseTaskAssignments` reads eligible implementer/reviewer agent IDs from the registry rather than alternating hardcoded `"claude"`/`"codex"` strings
- [x]6.2 Update `src/phases/implementation.ts`: `getAgentCtx()` uses `registry` from context; remove hardcoded `claudeCli`/`codexCli` fields
- [x]6.3 Update `src/index.ts`: pass `registry` and `spawnTracker` into `AgentToolsContext`; remove `claudeCli`/`codexCli` fields; pass `reviewerAgentIds` (`registry.reviewers()`) to `ConsensusLoop`

## 7. Test Updates

- [x]7.1 Update `tests/agent-tools.test.ts`: replace `makeCtx()` model fields with `registry` and `spawnTracker`; use `invokeAgentTool` with a mock registry
- [x]7.2 Update `tests/consensus.test.ts`: replace two-slot mock fns with `reviewerAgentIds` array and single injectable `invokeAgent`; add N=3 agent test cases
- [x]7.3 Update `tests/e2e.test.ts`: config object uses new agent map shape; consensus loop constructed with agent ID array
- [x]7.4 Update `tests/implementation.test.ts`: task assignment uses agent IDs from a test registry rather than hardcoded strings
- [x]7.5 Add `tests/spawn-controls.test.ts`: full guardrail suite as specified in spawn-controls spec

## 8. Documentation

- [x]8.1 Update `readme.md`: prerequisites section describes multi-agent config; mcp-config.json example shows named agents with `specialty` and spawning block; remove references to `invoke_claude`/`invoke_codex`
- [x]8.2 Update `docs/tools.md`: replace `invoke_claude`/`invoke_codex` entries with `invoke_agent`; document all parameters including `invocationContext`; document `spawn_rejected` audit entry type
- [x]8.3 Update `docs/architecture.md`: update ASCII message-flow diagram to show N-agent parallel review and call-tree depth; note `allowSubInvocation` as the delegation control
- [x]8.4 Update `docs/session-format.md`: document new `spawnStats` field in `state.json`, note backwards-compatible load defaults, and add `spawn_rejected` and `spawn_budget_warning` to audit log entry type reference
