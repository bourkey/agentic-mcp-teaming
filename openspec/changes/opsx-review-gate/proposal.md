## Why

OpenSpec changes are currently proposed and applied without any automated review — specs and code land based on a single agent's judgment alone. This change introduces a multi-agent review gate that runs automatically after `/opsx:propose` and `/opsx:apply`, catching security issues, design problems, and quality gaps before they are committed.

## What Changes

- After `/opsx:propose` completes, a spec review gate automatically invokes a set of specialised Claude sub-agents (security, design, completeness, consistency) plus a Codex peer reviewer in parallel; findings are synthesised, agreed fixes are applied to the artifact files, and the user is notified of the outcome before `/opsx:apply` is permitted
- After `/opsx:apply` completes, a code review gate runs the same pattern against the generated code (security, code quality, error handling, test coverage) plus Codex peer review; agreed fixes are applied to source files
- A synthesis agent runs after all reviewers in each gate to deduplicate findings, detect conflicting fixes, and classify severity so that aggregation is reliable
- Critical and contested findings escalate to the user (Claude in VSCode); all other findings are resolved and applied automatically
- Sub-agent roles and Codex peer reviewer are configured in `mcp-config.json`; optional roles (scope, migration, performance, dependency) can be flagged per change

## Capabilities

### New Capabilities

- `spec-review-gate`: Automated multi-agent review of OpenSpec artifacts (proposal, design, specs, tasks) after propose; applies agreed fixes before apply is permitted
- `code-review-gate`: Automated multi-agent review of generated code after apply; applies agreed fixes to source files
- `review-synthesis`: Synthesis agent that deduplicates findings across reviewers, detects conflicting fixes, and classifies severity consistently before aggregation
- `review-agent-registry`: Configuration model for named reviewer sub-agents (role, tool, system prompt, stage) in `mcp-config.json`; controls which agents run at each gate

### Modified Capabilities

- `consensus-workflow`: Review gate uses a variant of the consensus protocol — findings-and-fix rather than approve/reject; severity-tiered automation replaces unanimous approval
- `mcp-integration`: `mcp-config.json` gains a `reviewers` block defining sub-agent roles; coordinator exposes new `invoke_reviewer` tool used by Claude in VSCode to dispatch reviewers

## Impact

- `mcp-config.json`: new `reviewers` block alongside existing `agents`
- `src/`: new `invoke_reviewer` MCP tool; synthesis agent invocation
- OpenSpec CLI skills (`opsx:propose`, `opsx:apply`): post-step hooks that trigger respective review gates
- No changes to existing consensus loop, session model, or worktree pipeline
- Requires `codex` CLI or equivalent peer reviewer to be configured; gracefully skips unavailable reviewers with a warning
- New artifact per change: `review-summary.md` written to `openspec/changes/<name>/` after each gate
