## Why

The current coordinator is hardcoded to exactly two agents (Claude and Codex) with two named MCP tools (`invoke_claude`, `invoke_codex`) and a two-slot consensus loop. Adding a third specialist — a security reviewer, a test writer, a performance analyst — requires source changes across the schema, MCP server, consensus loop, and config. Sub-agent delegation is invisible to the coordinator, leaving no audit trail when an agent spawns further agents to parallelise work. This change refactors the coordinator into a dynamic, N-agent system where agents are declared in config, all invocations flow through a single `invoke_agent` MCP tool, consensus requires unanimous agreement (any dissent surfaces to the human), and the coordinator enforces hard guardrails against runaway spawning.

## What Changes

- `invoke_claude` and `invoke_codex` MCP tools replaced by a single generic `invoke_agent(agentId, prompt, context)` tool backed by a named agent registry in `mcp-config.json`
- Agent registry supports any number of named agents, each with a CLI path, optional specialty description, and explicit capabilities that determine whether the agent may review, revise artifacts, implement tasks, or invoke other agents
- Consensus loop generalised from two named slots to `agents[]` with unanimous policy: any `block` or unresolved `request-changes` after max rounds escalates to a human checkpoint
- Multi-agent feedback aggregation: when multiple agents request changes, all feedback is merged into a single revision request before passing to a configured revising agent
- Sub-agent delegation: agents that are launched with coordinator MCP access may call `invoke_agent` during their own turn; the coordinator injects transport details for eligible agents and tracks parent/child invocation IDs forming a full call tree in the audit log
- Spawning guardrails enforced by the coordinator: registry check, depth limit, sub-invocation concurrent cap, session invocation budget — violations logged and escalated
- Parallel first-pass review: all reviewer agents invoked concurrently via `Promise.all` rather than sequentially
- **BREAKING**: `invoke_claude` and `invoke_codex` MCP tool names removed; any external MCP client calling those tools must migrate to `invoke_agent`
- **BREAKING**: `mcp-config.json` `agents` shape changes from `{ claude: { cli }, codex: { cli } }` to a named map with `specialty`, capability flags, and spawning/consensus config blocks

## Capabilities

### New Capabilities

- `agent-registry`: Named agent configuration in `mcp-config.json` — each entry declares a CLI path, optional specialty prompt, and capability flags controlling review, revision, implementation, and sub-invocation; loaded at startup and validated before any workflow phase begins
- `invoke-agent-tool`: Single generic `invoke_agent(agentId, prompt, context)` MCP tool replacing the two hardcoded tools; dispatches to any registered agent, enforces all spawning guardrails, and logs a full invocation record including parent/child IDs
- `n-agent-consensus`: Generalised consensus loop operating over `agents[]`; unanimous approval required; aggregates multi-agent feedback for revision; escalates any block or cap breach to a human checkpoint
- `spawn-controls`: Coordinator-enforced guardrails on `invoke_agent` calls — registry membership check, call-tree depth limit, concurrent sub-invocation cap, and per-session invocation budget; all violations logged as `spawn_rejected` audit entries

### Modified Capabilities

- `agent-orchestration`: Session initialisation now loads and validates the agent registry instead of two fixed API configs; turn-based routing uses `invoke_agent` with agent IDs from the registry
- `mcp-integration`: `invoke_agent` replaces `invoke_claude`/`invoke_codex`; Codex context-injection behaviour preserved for any agent whose CLI does not natively speak MCP

## Impact

- `src/server/tools/agents.ts` — rewritten: two tool functions replaced by `invokeAgentTool(agentId, ...)`
- `src/server/index.ts` — registers `invoke_agent` dynamically from config; removes `invoke_claude`/`invoke_codex` registrations
- `src/core/consensus.ts` — two-slot loop replaced by N-agent array; `evaluateConsensus` updated for unanimous policy and feedback aggregation
- `src/core/session.ts` — tracks active invocation count, call-tree depth per chain, session invocation budget
- `src/core/session.ts` — persists spawn counters with backwards-compatible defaults on load so pre-change sessions remain resumable
- `src/config.ts` — new schema for agents map, `consensus` block, `spawning` block
- `src/schema.ts` — `AgentRole` enum relaxed to open string; new `InvocationContext` type with `invocationId`, `parentInvocationId`, `depth`
- `src/phases/implementation.ts` — task assignment reads agent IDs from registry rather than hardcoded roles
- `mcp-config.json` — updated to new shape; existing `claude`/`codex` entries migrated to named agents
- All existing tests updated; new tests for N-agent consensus, spawning guardrails, and call-tree tracking
