Model Orchestration: Stream-Watching and Delegation

Core Concept

Rather than intercepting low-level model API calls or patching the Claude Code binary, the system operates at the JSONL event stream layer — the same structured output that Claude Code already produces when run with `--output-format stream-json --verbose`. This makes the approach harness-agnostic: any runner that can spawn a subprocess and read its stdout can implement this pattern.

────────────────────────────────────────

1. The Stream Interface

Claude Code emits newline-delimited JSON (JSONL) events to stdout. The harness reads these line-by-line and deserializes each into a typed event:

┌───────────────────┬──────────────────────────┬───────────────────────────────────────────────────────────────┐
│ Event type        │ Key fields               │ Purpose                                                       │
├───────────────────┼──────────────────────────┼───────────────────────────────────────────────────────────────┤
│ `system`          │ `session_id`, `model`    │ Session initialization; confirms which model is active        │
│ `assistant`       │ `model`, `usage`         │ Claude's response content; also carries the active model name │
│ `tool_use`        │ `name`, `id`, `input`    │ Claude is calling a tool — this is the delegation trigger     │
│ `tool_result`     │ `tool_use_id`, `content` │ Tool returned a result                                        │
│ `control_request` │ `type`, `tool_name`      │ Needs external approval (e.g. permission prompts)             │
│ `result`          │ `usage`, `cost`          │ Turn complete; carries cumulative token counts                │
└───────────────────┴──────────────────────────┴───────────────────────────────────────────────────────────────┘

The harness never needs to introspect model internals — it just parses these events. The `model` field in `system` and `assistant` events provides observability into what model is actually running.

────────────────────────────────────────

2. The Sub-Agent Definitions

Before the primary session starts, the harness writes two markdown files to `~/.claude/agents/`. Claude Code's native `Agent` tool reads these files when `subagent_type` matches the filename stem — they are the complete specification for each sub-agent, including which model to use.

`~/.claude/agents/conduit-explore.md`

```markdown
---
name: conduit-explore
description: Fast codebase exploration agent using a cheaper model. Use when you
  need to read multiple files, search for patterns, or summarize codebase context
  for a specific task. Returns concise summaries instead of raw file contents.
model: claude-haiku-4-5
---

You are a fast, efficient codebase exploration agent. Your purpose is to read
files, search for patterns, and return concise summaries — never dump raw file
contents.

Rules:
- Complete your task in 3-8 tool calls
- Summarize only what is relevant to the caller's question, not everything you found
- When multiple independent searches could run in parallel, use parallel tool calls
  in a single turn
- Do not edit files
- Return results immediately without narration
```

`~/.claude/agents/conduit-review.md`

```markdown
---
name: conduit-review
description: Fast diff/change reviewer using a cheaper model. Use when you need a
  quick review of changes, want to identify issues in a diff, or need a summary of
  what changed and potential risks.
model: claude-haiku-4-5
---

You are a focused code reviewer. Analyze diffs and code changes, then return a
brief structured report.

Cover these areas:
- Correctness issues
- Potential bugs or regressions
- Security concerns
- Performance implications

Do not repeat large blocks of code in your report.
```

Several design choices here are worth noting:

• The `model:` frontmatter field is what actually routes the sub-task to Haiku. The harness doesn't issue a "use this model" command — it's declared in the file.
• The `description:` field is the primary signal the main model (Opus) uses when deciding whether to delegate. It reads like an instruction: "use when you need to…". This is what makes the delegation decision the main model's own reasoning rather than a harness heuristic.
• The body constraints (3-8 tool calls, summaries not raw content, no narration) are deliberately tight. The goal is to keep the sub-agent cheap and fast, and to prevent it from expanding scope or inflating the main session's context with raw file dumps.
• Idempotent writes: the harness only writes each file if its content differs from what's already on disk, so repeated session starts don't cause unnecessary I/O.

────────────────────────────────────────

3. The Orchestration Instructions Injected Into the Prompt

Writing the agent files to disk is necessary but not sufficient — the main model also needs to know these agents exist and when to use them. So the harness appends the following block to every user prompt when orchestration is enabled:

```
---
Orchestration mode is active for this session. Before loading large amounts of raw
file content into this context, delegate to the sub-agents below via the Agent tool:

- **conduit-explore**: for reading/summarizing files, searching patterns, gathering
  codebase context
- **conduit-review**: for reviewing diffs or code changes before acting on them

These sub-agents use a cheaper model and return concise summaries, keeping this
context window lean.
```

This prompt injection is the bridge between the agent definition files and the main model's behaviour. Without it, Opus would have no reason to reach for those agents. The instructions frame delegation as a context hygiene measure ("keeping this context window lean") rather than just cost-saving — which aligns with how Opus reasons about tool choice.

────────────────────────────────────────

4. The Delegation Trigger: Watching for the `Agent` Tool

Model switching is not triggered by pattern-matching on Claude's prose output. Instead, it's triggered by a specific tool call event.

When the stream emits a `tool_use` event where `name == "Agent"`, the harness inspects the `input.subagent_type` argument. This is the discriminator:

```
ToolStarted { tool_name: "Agent", arguments: { subagent_type: "conduit-explore" } }
  → route to Haiku (fast/cheap exploration model)

ToolStarted { tool_name: "Agent", arguments: { subagent_type: "conduit-review" } }
  → route to Haiku (fast/cheap review model)

ToolStarted { tool_name: "Agent", arguments: { subagent_type: "general-purpose" } }
  → pass through to user-selected model
```

The harness reads the `tool_use_id` from this event and holds it. When a `tool_result` event arrives with a matching `tool_use_id`, the delegation window closes. This gives a clean start/end bracket for the sub-agent lifecycle.

────────────────────────────────────────

5. No Mid-Stream Model Replacement

The primary session's model never changes after launch. There is no signal sent mid-stream to swap the running model. Instead:

• Primary session: Main model (Opus) starts and runs for the full turn
• Delegated sub-session: A separate Haiku process handles the bounded sub-task
• These run sequentially (the `Agent` tool blocks the primary until the sub-agent completes)

From the harness's perspective, you never need to kill and relaunch the primary process. You just watch the stream, detect `Agent` tool calls, update display state, and let Claude Code handle the actual sub-agent execution.

────────────────────────────────────────

6. State Machine (Simplified)

```
IDLE
  → [prompt submitted] → write agent defs to ~/.claude/agents/ (if stale)
                       → append orchestration instructions to prompt
                       → spawn: claude --output-format stream-json --model opus
                       → RUNNING

RUNNING
  → [stream: tool_use, name=Agent, subagent_type=conduit-explore]
     → capture tool_use_id
     → transition to DELEGATING (label="Explore", model="claude-haiku-4-5")

DELEGATING
  → [stream: tool_result, id matches captured tool_use_id]
     → clear delegation state
     → transition back to RUNNING
  → [stream: result (turn complete)]
     → transition to IDLE

RUNNING / DELEGATING
  → [stream: control_request, type=non-interactive] → auto-approve via stdin
  → [stream: control_request, type=requires-user]   → surface to UI
```

────────────────────────────────────────

7. Why This Approach is Harness-Agnostic

┌───────────────────────────┬───────────────────────────────────────────────────────────────┐
│ Concern                   │ How it's handled                                              │
├───────────────────────────┼───────────────────────────────────────────────────────────────┤
│ Which model is running    │ Read from `model` field in stream events                      │
│ When delegation starts    │ `tool_use` event with `name == "Agent"`                       │
│ Which sub-agent / model   │ `input.subagent_type` arg + `model:` in agent definition file │
│ When delegation ends      │ `tool_result` with matching `tool_use_id`                     │
│ What triggers delegation  │ Prompt instructions + agent `description:` field              │
│ Sub-agent model selection │ Declared in agent definition file, not in harness code        │
└───────────────────────────┴───────────────────────────────────────────────────────────────┘

The harness never issues a "switch to model X" command. It only observes, surfaces state to the UI, and responds to `control_request` events. The actual model selection is pushed entirely into the sub-agent definition files and the appended prompt block — both of which are plain text and trivially portable to any harness that can spawn a subprocess and read JSONL from stdout.