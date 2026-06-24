## 1. MCP Server: invoke_reviewer tool

- [x] 1.1 Define `ReviewerFindings` TypeScript type (finding, severity, proposedFix, location fields)
- [x] 1.2 Add `invoke_reviewer` tool registration to the coordinator MCP server alongside `invoke_agent`
- [x] 1.3 Implement `invoke_reviewer` handler: parse reviewer config from `mcp-config.json` reviewers block, spawn CLI subprocess, capture stdout, parse as `ReviewerFindings`
- [x] 1.4 Handle `invoke_reviewer` timeout: return empty findings with timeout warning, do not abort gate
- [x] 1.5 Add `reviewers` block parsing and validation to config loader (validate required fields: stage, role, specialty; validate cli entries are strings)
- [x] 1.6 Add unit tests for `invoke_reviewer` handler (success, timeout, CLI not found, empty findings)

## 2. Reviewer Config Schema

- [x] 2.1 Add `reviewers` block to `mcp-config.json` with default entries: `claude-security`, `claude-design`, `claude-completeness`, `claude-consistency` (spec stage), `claude-quality`, `claude-error-handling`, `claude-test-coverage` (code stage), `codex-peer` (both stages, optional, cli: "codex")
- [x] 2.2 Add TypeScript type for reviewer config entry (`ReviewerConfig`: role, stage, specialty, optional, cli?)
- [x] 2.3 Validate at startup that all non-optional reviewers without `cli` have valid `role` and `specialty`

## 3. run-review-gate Skill

- [x] 3.1 Create `.claude/skills/run-review-gate.md` skill file
- [x] 3.2 Implement skill: accept `stage` (spec|code) and `changeName` parameters
- [x] 3.3 Implement parallel Claude sub-agent dispatch: read reviewers from mcp-config.json, filter by stage, launch all non-cli reviewers via Agent tool simultaneously
- [x] 3.4 Implement parallel CLI reviewer dispatch: for each cli reviewer in stage, call `invoke_reviewer` MCP tool; handle optional reviewer unavailability with warning
- [x] 3.5 Implement synthesis agent call: collect all raw findings, invoke synthesis Agent with structured prompt, parse SynthesisResult
- [x] 3.6 Implement auto-apply loop: iterate SynthesisResult findings, apply edits for auto-apply dispositions, escalate contested/critical-contested findings to user
- [x] 3.7 Write `review-gate.lock` to change directory on gate completion
- [x] 3.8 Write/append `review-summary.md` with findings table (reviewer, severity, finding, fix applied/escalated)

## 4. Synthesis Agent Prompt

- [x] 4.1 Create synthesis agent prompt template: takes array of raw reviewer findings, produces structured SynthesisResult JSON
- [x] 4.2 Define SynthesisResult schema: findings array (finding, severity, reviewers[], proposedFix, disposition: auto-apply|escalate|drop), conflictPairs array
- [x] 4.3 Include severity classification rules in prompt: critical = security/correctness, major = design/quality with 2+ agreement, minor = style/cosmetic
- [x] 4.4 Include conflict detection rules in prompt: overlapping file sections → conflict pair → escalate

## 5. opsx:propose Skill Update

- [x] 5.1 Add post-step hook to `opsx:propose` skill: after artifacts are written, call `run-review-gate` with `stage: spec` and the change name
- [x] 5.2 Add check for `review-gate.lock` in `opsx:apply` skill: warn if absent but do not hard-block

## 6. opsx:apply Skill Update

- [x] 6.1 Add post-step hook to `opsx:apply` skill: after all tasks complete, call `run-review-gate` with `stage: code` and the change name
- [x] 6.2 Ensure code gate receives list of files modified during apply as part of context passed to reviewers
