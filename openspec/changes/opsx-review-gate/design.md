## Context

The coordinator already has a working `invoke_agent` MCP tool that calls CLIs as subprocesses and returns structured `AgentMessage` responses. Claude Code (running in the user's VS Code session) is the orchestrator for review gates — it spawns sub-agents natively via the Agent tool and calls the coordinator MCP's `invoke_reviewer` tool for external CLI peers (Codex). The review gate is not a background process; it runs inline in the same Claude session immediately after `/opsx:propose` or `/opsx:apply` completes.

## Goals / Non-Goals

**Goals:**
- Spec review gate runs automatically after `/opsx:propose`; blocks `/opsx:apply` until complete
- Code review gate runs automatically after `/opsx:apply`; applies fixes to source files
- Sub-agent roles (security, design, completeness, consistency, code quality, error handling, test coverage) run in parallel via Claude's native Agent tool
- Codex (or any configured external CLI) runs as a single peer reviewer via `invoke_reviewer` MCP tool
- Synthesis agent deduplicates, detects conflicts, and classifies severity across all findings
- Critical + contested findings escalate to user; all others auto-applied
- `review-summary.md` written to change directory as audit trail
- Sub-agent roles and peer reviewers configured in `mcp-config.json` under a new `reviewers` block
- Optional roles (scope, migration, performance, dependency) activatable per change

**Non-Goals:**
- Review gate as a persistent background process or daemon
- Parallel code review across multiple files simultaneously (sequential per changed file for v1)
- GUI panel in the VS Code extension for review gate (chat output is sufficient for v1)
- Review of changes outside the OpenSpec workflow (arbitrary file changes, git commits)
- Enforcement mechanism preventing apply without review (honour system for v1 — gate runs automatically but is not a hard lock)

## Decisions

### 1. Claude in VSCode as orchestrator, not the coordinator CLI

**Decision:** The review gate is driven by Claude in the active VS Code session using the Agent tool for sub-agents and the coordinator MCP's `invoke_reviewer` for external CLIs. The coordinator CLI process is not involved in review.

**Rationale:** The user is already in a Claude session at the point where `/opsx:propose` or `/opsx:apply` completes. Driving the gate from that session means zero additional setup, no server to start, and the user naturally stays in context. The coordinator CLI was designed for the implementation phase (worktrees, parallel tasks, git isolation) — review is lighter and fits naturally in-session.

**Alternatives considered:**
- Coordinator CLI orchestrates review: requires coordinator to be running at propose/apply time, adds startup latency, and routes findings through the coordinator's audit log rather than the conversation where the user is already working.
- VS Code extension drives review: extension can't invoke Agent tool; would need its own agent runtime.

### 2. Claude sub-agents via Agent tool; Codex via `invoke_reviewer` MCP tool

**Decision:** Claude sub-agents (security, design, completeness, consistency, code quality, error handling, test coverage) are spawned using Claude's native Agent tool. External CLI peers (Codex) are called via a new `invoke_reviewer` MCP tool on the coordinator server, which wraps the existing `invoke_agent` logic but returns structured `ReviewerFindings` instead of `AgentMessage`.

**Rationale:** The Agent tool is the natural primitive for Claude sub-agents — it handles prompt construction, timeout, and response parsing natively. Codex doesn't support the Agent tool; it needs a CLI invocation. Routing Codex through the coordinator MCP (which already handles CLI subprocess invocation) reuses existing infrastructure and keeps the coordinator as the single point of external agent calls.

**Alternatives considered:**
- All reviewers via coordinator MCP: loses the native Agent tool capabilities for Claude sub-agents; adds unnecessary indirection.
- Codex invoked directly via Bash tool: works but couples review orchestration to shell invocation details; harder to configure and extend to other external tools.

### 3. Synthesis agent as a separate lightweight Claude Agent call

**Decision:** After all parallel reviewer findings are collected, a synthesis agent (a single Claude Agent tool call) receives all raw findings and produces a structured `SynthesisResult`: deduplicated findings list, conflict pairs, severity classifications, and a proposed fix for each finding.

**Rationale:** Without synthesis, Claude in VSCode must manually deduplicate and compare potentially noisy, inconsistently formatted output from 5–8 agents. A synthesis agent converts raw findings into a reliable structured input for the auto-apply and escalation logic. The synthesis agent is stateless and cheap — it only processes text, makes no tool calls.

**Alternatives considered:**
- Claude in VSCode does synthesis inline: error-prone at scale; synthesis logic buried in review orchestration.
- Synthesis built into each reviewer: fragments the deduplication problem; reviewers don't have visibility into other reviewers' findings.

### 4. Severity-tiered automation with critical+contested escalation

**Decision:** Findings are classified as `critical`, `major`, or `minor`. Auto-apply rules:
- `critical` (any source): fix applied automatically; if fix is contested between reviewers → escalate to user
- `major` (2+ reviewers agree): fix applied automatically; if only 1 reviewer flagged → Claude in VSCode decides inline (no user interrupt unless it asks)
- `minor`: applied only if all reviewers agree; otherwise silently dropped

Escalation to user = Claude surfaces it in conversation and waits for instruction.

**Rationale:** Matches how experienced human code review works. The user only sees genuinely ambiguous high-stakes decisions. Minor disagreements don't interrupt flow.

**Alternatives considered:**
- Unanimous approval required: too conservative; one noisy agent blocks everything.
- Union of findings (apply everything): over-fixes; conflicting suggestions produce broken artifacts.
- Two-pass cross-review (agents review each other's findings): doubles agent calls and latency for marginal gain in v1.

### 5. `reviewers` block in `mcp-config.json`

**Decision:** Reviewer sub-agent roles are defined in a new `reviewers` block in `mcp-config.json`:

```json
"reviewers": {
  "claude-security": {
    "stage": ["spec", "code"],
    "role": "security",
    "specialty": "Security vulnerabilities, threat model gaps, auth/authz issues",
    "optional": false
  },
  "codex-peer": {
    "cli": "codex",
    "stage": ["spec", "code"],
    "role": "peer",
    "specialty": "Cross-cutting peer review from an independent model",
    "optional": true
  }
}
```

Entries without a `cli` field are Claude sub-agents (Agent tool). Entries with a `cli` field are external CLI reviewers (invoke_reviewer MCP tool). The `stage` field controls which gate they run in (`spec`, `code`, or both). `optional: true` reviewers are skipped with a warning if their CLI is unavailable.

**Rationale:** Single config source for both agents and reviewers. The `cli` presence/absence cleanly separates Claude sub-agents from external CLI peers without a separate type discriminator.

### 6. opsx:propose and opsx:apply skills trigger gates via post-step instructions

**Decision:** The review gate is triggered by adding post-step instructions to the `opsx:propose` and `opsx:apply` skills: after artifacts are written / after implementation is complete, Claude (the skill executor) calls a shared `run-review-gate` skill with the appropriate stage and change context.

**Rationale:** Skills are the correct extension point — they run in Claude's session, have access to the Agent tool, and compose naturally. No changes to the coordinator CLI are needed.

### 7. `review-summary.md` as the audit artifact

**Decision:** After each gate, Claude writes `openspec/changes/<name>/review-summary.md` (spec gate) or appends a `## Code Review` section (code gate). Format: table of findings with reviewer, severity, finding, fix applied / escalated.

**Rationale:** Persistent record outside the conversation; reviewable when resuming work; shareable with collaborators.

## Risks / Trade-offs

- **Agent call cost and latency** → 6–9 agents per gate × 2 gates = 12–18 agent calls per change. Mitigation: parallel execution within each stage; optional roles off by default; synthesis is cheap.
- **Synthesis agent misclassifies severity** → A misclassified critical issue becomes minor and is silently dropped. Mitigation: err on the side of higher severity in the synthesis prompt; ship conservative defaults.
- **Conflicting fixes produce broken artifacts** → Two agents suggest incompatible edits to the same section. Mitigation: synthesis detects conflict pairs and escalates them rather than applying either fix.
- **Codex unavailable** → `optional: true` on the codex-peer reviewer means the gate proceeds without it, with a warning. Mitigation: log clearly, don't silently degrade.
- **Review gate on already-applied code is post-hoc** → Code review after apply means fixes go into a second commit. Mitigation: acceptable trade-off for v1; pre-apply code review requires agent to review against a diff that doesn't exist yet.
- **Skills not enforcing the gate** → User could `/opsx:apply` without running the spec review. Mitigation: spec review gate writes a `review-gate.lock` file to the change dir that the apply skill checks; missing lock = warning, not hard block (v1).

## Migration Plan

1. Add `reviewers` block to `mcp-config.json` (backward-compatible addition; existing `agents` block unchanged)
2. Add `invoke_reviewer` tool to coordinator MCP server
3. Implement `run-review-gate` as a Claude Code skill
4. Update `opsx:propose` skill to call spec review gate after artifact creation
5. Update `opsx:apply` skill to call code review gate after implementation completes
6. No changes to existing session model, consensus loop, or worktree pipeline
7. Rollback: remove `reviewers` block from config; remove skill post-step calls; gates stop firing

## Open Questions

- Should the review gate apply fixes directly to artifact files, or produce a diff for the user to approve first? (Current design: apply directly with summary — but a diff preview mode could be a v2 option.)
- For the code review gate, should fixes be applied to the source files directly or committed as a separate "review fixes" commit on the session branch?
- Should `review-gate.lock` be a real enforcement mechanism (apply skill hard-blocks) or just a warning in v1?
