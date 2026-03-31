---
name: run-review-gate
description: Run the multi-agent review gate for an OpenSpec change. Dispatches Claude sub-agents and optional CLI peer reviewers in parallel, synthesises findings, applies agreed fixes, and writes review-summary.md.
license: MIT
compatibility: Requires mcp-config.json with reviewers block. Requires coordinator MCP server running for CLI reviewer dispatch.
metadata:
  author: opsx
  version: "1.0"
---

Run the review gate for an OpenSpec change.

**Parameters (from calling skill):**
- `stage`: `spec` or `code`
- `changeName`: the OpenSpec change name

---

## Steps

### 1. Load reviewer configuration

Read `mcp-config.json` and extract all entries from the `reviewers` block that have `stage` containing the current stage value.

Split them into two lists:
- **Claude sub-agents**: entries WITHOUT a `cli` field
- **CLI reviewers**: entries WITH a `cli` field

### 2. Build artifact context

**For `spec` stage:**
Read the following files from `openspec/changes/<changeName>/` and concatenate their contents into a single context string:
- `proposal.md`
- `design.md`
- All files matching `specs/**/*.md`

**For `code` stage:**
Use the list of source files modified during `/opsx:apply` (passed as context). Read each file and concatenate. Also include the relevant spec files from `openspec/specs/` for cross-reference.

### 3. Dispatch all reviewers in parallel

**Claude sub-agents** — launch ALL simultaneously via the Agent tool. For each:
```
subagent_type: general-purpose
prompt: |
  You are a <role> reviewer with specialty: <specialty>.

  Review the following <stage> artifacts and return ONLY a JSON object:
  {
    "findings": [
      {
        "finding": "<description>",
        "severity": "critical" | "major" | "minor",
        "proposedFix": "<concrete fix>",
        "location": "<file or section>"
      }
    ]
  }

  Severity:
  - critical: security, data loss, broken correctness, fundamental design flaw
  - major: design/interface/quality issue affecting maintainability
  - minor: style, naming, cosmetic

  Return empty findings array if no issues found.

  ---

  <artifact content>
```

**CLI reviewers** — for each, call `invoke_reviewer` MCP tool:
```
reviewerId: <id>
stage: <stage>
artifactContent: <artifact content>
```

Handle optional CLI reviewers:
- If `invoke_reviewer` returns an error about CLI not found: log warning `"Skipping optional reviewer <id>: CLI unavailable"`, continue
- If `timedOut: true`: log warning `"Reviewer <id> timed out, skipping"`

### 4. Collect all raw findings

Wait for all parallel dispatches to complete. Combine all `ReviewerFinding[]` arrays tagged with their reviewer ID into a single `RawFindingSet`:

```json
[
  { "reviewerId": "claude-security", "findings": [...] },
  { "reviewerId": "codex-peer", "findings": [...] }
]
```

### 5. Run synthesis agent

Call a single Agent tool invocation (synthesis agent):

```
subagent_type: general-purpose
prompt: |
  You are a synthesis agent. Your job is to deduplicate, classify, and determine disposition for review findings.

  INPUT — raw findings from multiple reviewers:
  <paste RawFindingSet as JSON>

  OUTPUT — respond ONLY with a JSON object matching this schema exactly:
  {
    "findings": [
      {
        "finding": "<deduplicated finding description>",
        "severity": "critical" | "major" | "minor",
        "reviewers": ["<reviewer-id>", ...],
        "proposedFix": "<best fix from reviewers, or merged>",
        "location": "<file or section>",
        "disposition": "auto-apply" | "escalate" | "drop"
      }
    ],
    "conflictPairs": [
      {
        "location": "<file or section>",
        "fixes": ["<fix A>", "<fix B>"],
        "reviewers": ["<reviewer A>", "<reviewer B>"]
      }
    ]
  }

  DEDUPLICATION RULES:
  - Merge findings that describe the same issue at the same location into one entry
  - Attribute merged findings to all reviewers who raised them
  - Preserve distinct findings separately

  SEVERITY CLASSIFICATION:
  - critical: security vulnerability, data loss risk, broken correctness guarantee, fundamental design flaw
  - major: design issue, interface problem, quality concern — especially if 2+ reviewers raised it
  - minor: style, naming, cosmetic, or low-impact
  - When in doubt, err toward higher severity

  DISPOSITION RULES:
  - critical + uncontested fix → auto-apply
  - critical + contested fix (incompatible fixes from 2+ reviewers) → escalate
  - major + 2 or more reviewers agree → auto-apply
  - major + only 1 reviewer → auto-apply (orchestrator decides inline)
  - minor + all reviewers agree → auto-apply
  - minor + disagreement → drop

  CONFLICT DETECTION:
  - If two reviewers propose incompatible fixes to the same file/section → add to conflictPairs, set disposition: escalate
```

Parse the synthesis agent's JSON output as `SynthesisResult`.

### 6. Apply findings

Iterate `SynthesisResult.findings`:

**`auto-apply`:**
- Use the Edit tool to apply `proposedFix` to the file at `location`
- If the fix is a description rather than an exact diff, make the minimal edit that satisfies it
- Log: `"Applied fix: <finding> at <location>"`

**`escalate`:**
- Surface to the user in conversation: describe the finding, show conflicting fixes if any
- Wait for user instruction before applying

**`drop`:**
- No action. Note in summary only.

For `conflictPairs`: surface each one to the user with both fix options.

### 7. Write review-gate.lock

Write `openspec/changes/<changeName>/review-gate.lock` with content:

```
stage: <stage>
timestamp: <ISO timestamp>
reviewers: <comma-separated list of reviewer IDs that ran>
```

### 8. Write review-summary.md

**Spec stage:** Create `openspec/changes/<changeName>/review-summary.md`

**Code stage:** Append a `## Code Review — <ISO date>` section to existing `review-summary.md`

Table format:

```markdown
## Spec Review — <ISO date>

| Reviewer | Severity | Finding | Location | Disposition |
|----------|----------|---------|----------|-------------|
| claude-security | critical | Missing auth check | src/server/index.ts | Applied |
| codex-peer | major | Design issue | proposal.md | Escalated |
| claude-design | minor | Naming inconsistency | specs/ | Dropped |

### Conflict Pairs

- **Location**: src/auth.ts — Fix A (claude-security): add JWT middleware. Fix B (codex-peer): use session tokens. **Escalated to user.**
```

### 9. Show conversational summary

Output a brief summary to the user:
- How many reviewers ran
- Finding counts by severity
- How many fixes were auto-applied, escalated, dropped
- Any escalated items that need user attention

---

## Example Output

```
Review gate complete (spec stage, change: my-feature)

Reviewers: claude-security, claude-design, claude-completeness, claude-consistency
Findings: 2 critical, 3 major, 4 minor

Auto-applied (4): ...
Escalated (1): Missing auth validation — conflicting fix proposals, see below
Dropped (4): Minor style issues

⚠ Escalation needed:
**Finding**: Auth token storage uses localStorage (security risk)
**claude-security suggests**: Move to httpOnly cookie
**codex-peer suggests**: Use in-memory storage only, no persistence
What would you like to do?
```
