## Why

AI coding agents like Claude and Codex operate in isolation today, each producing independent outputs without cross-validation or collaborative refinement. This project establishes a teaming framework where Claude and Codex work together — reviewing each other's work, reaching consensus on plans and designs, and co-implementing code — so that outputs are better reasoned, less error-prone, and grounded in mutual agreement before any action is taken.

## What Changes

- Introduce an MCP-based orchestration layer that routes tasks between Claude and Codex agents
- Implement a consensus protocol allowing agents to propose, review, negotiate, and approve artifacts (proposals, designs, specs, tasks, code)
- Add a shared task execution model where both agents can contribute to and validate implementation steps
- Isolate implementation work in Git branches/worktrees so concurrent tasks can proceed without mutating the same checkout
- Provide a human-in-the-loop interface for final approval at key workflow checkpoints
- Define the communication format (message schema) used between agents for structured collaboration
- Provide complete documentation covering installation, configuration, architecture, MCP tool reference, and session/audit log format

## Capabilities

### New Capabilities

- `agent-orchestration`: Coordinates Claude and Codex as a team — routing requests, managing turn-taking, and tracking shared state across a session
- `consensus-workflow`: Enables agents to reach mutual agreement on artifacts; each agent reviews and either approves, requests changes, or raises concerns before the workflow advances
- `mcp-integration`: Exposes tools and review snapshots to both agents via MCP so each agent evaluates the same captured context for a review round
- `task-execution`: Collaborative implementation phase where agents divide, implement, and cross-review code changes derived from agreed tasks
- `documentation`: End-user and developer documentation covering setup, architecture, MCP tool API, and data formats — necessary for anyone operating or extending the teaming framework

### Modified Capabilities

## Impact

- New project: no existing code is modified
- Requires MCP server configuration for both Claude (claude-code) and Codex (openai codex CLI or API)
- Introduces a coordinator process (likely a Node.js or Python script) that mediates agent communication
- Requires a local Git repository and uses branches/worktrees as the task isolation mechanism during implementation
- Agent outputs and consensus logs stored locally for auditability
- No external infrastructure or API keys required — runs entirely within the IDE context using existing CLI authentication
- Documentation ships alongside the code; `readme.md` is the primary entry point, `docs/` contains architecture, tool reference, and data format guides
