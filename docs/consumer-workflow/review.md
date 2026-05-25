Run a multi-agent review of an OpenSpec change with an iterative fix-and-re-review cycle.

**Input**: Optionally specify a change name (e.g., `/opsx:review add-auth`) and mode flag (`--artifacts` or `--implementation`). If omitted, infer from context.

**Steps**

0. **Verify not on main — unconditional first action, before any file reads or agent spawning**

   ```bash
   git branch --show-current
   ```

   - If the result is `main`: **stop immediately**. Print "`/opsx:review` runs from a worktree, not the main checkout. Switch to your area's pane (`cd ../generic-consumer-<area> && claude`) and re-run." Do not execute any further steps.
   - If the result is an empty string (detached HEAD): **stop immediately**. Print "Check out a named feature branch before running `/opsx:review` — detached HEAD cannot be associated with a change." Do not execute any further steps.
   - Otherwise: proceed.

   This guard MUST fire before any file read, agent spawn, or other action.

1. **Select the change**

   If a name is provided, use it. Otherwise infer from conversation context (e.g., the most recently applied or proposed change). Always announce which change is being reviewed.

2. **Determine mode**

   - `--artifacts`: Review proposal, design, and specs (run after `/opsx:propose`)
   - `--implementation`: Review implementation against specs (run after `/opsx:apply`)
   - If no flag is given: check whether `tasks.md` exists and has any `[x]` tasks — if yes, default to `--implementation`; otherwise default to `--artifacts`

3. **Pre-flight: resolve paths and commit range** (implementation mode only)

   Before spawning any review agents, do this work yourself:

   a. **Resolve specs path** — check if the change is still active or has been archived:
      ```bash
      ls openspec/changes/<name>/ 2>/dev/null || ls openspec/changes/archive/*-<name>/ 2>/dev/null
      ```
      Set `SPECS_PATH` to the resolved directory (e.g., `openspec/changes/<name>/` or `openspec/changes/archive/2026-04-14-<name>/`).

   b. **Identify the commit range for this change** — find all commits that belong to this change:
      ```bash
      git log --oneline | grep -i "<name>"
      ```
      If that returns nothing, use the tasks file commit timestamps or recent log to narrow down. Identify the FIRST and LAST commits that belong to this change. Set `COMMIT_RANGE` to e.g. `abc123^..def456`.

      If no clean range is identifiable, diff the files listed in the proposal's Impact section.

   c. **Enumerate in-scope files** — produce the definitive list of files changed by this change:
      ```bash
      git diff --name-only <COMMIT_RANGE>
      ```
      This is `IN_SCOPE_FILES`. Do NOT include untracked files — only files that appear in the identified commits.

   d. **Produce a context block to embed in every agent prompt:**
      ```
      CHANGE CONTEXT:
      - Change name: <name>
      - Specs path: <SPECS_PATH>
      - Commit range: <COMMIT_RANGE>
      - In-scope files (only review these):
        <IN_SCOPE_FILES listed one per line>
      - Do NOT review untracked files or files not in this list, even if git status shows them.
      ```

4. **Iterative review loop (up to 5 rounds)**

   Initialize: `round = 1`, `MAX_ROUNDS = 5`, `round_log = []`

   **Each round:**

   a. Announce: `--- Review Round <round> / <MAX_ROUNDS> ---`

   b. **Run all primary review agents in parallel** — launch all agents simultaneously in a single Agent tool message. For implementation mode, embed the `CHANGE CONTEXT` block at the top of every agent prompt.

   c. **Run the meta-reviewer** — after the parallel agents complete, run one meta-review agent (sequentially, with the collected findings as input). See prompt below.

   ---

   ### Artifacts mode (`--artifacts`)

   **Structural Spec Reviewer** (subagent_type: `Code Reviewer`) prompt:
   > "You are a STRUCTURAL reviewer only. Do not make behavioral claims.
   >
   > Review the spec files for the `<name>` change under `openspec/changes/<name>/specs/` and the proposal at `openspec/changes/<name>/proposal.md`. Check only structural properties: (1) every requirement uses SHALL/MUST (not should/may); (2) every scenario uses exactly `####` (4 hashtags); (3) every scenario follows WHEN/THEN format; (4) every requirement has at least one scenario; (5) MODIFIED requirements include the full updated block; (6) every capability in the proposal has a matching spec file; (7) every spec file has a corresponding capability in the proposal. Report findings with exact file:line references. Group by severity: critical, major, minor."

   **Behavioral Spec Reviewer** (subagent_type: `Code Reviewer`) prompt:
   > "You are a BEHAVIORAL reviewer only. Do not count hashtags, check formatting, or verify task coverage — that is handled by another reviewer.
   >
   > Read all spec files under `openspec/changes/<name>/specs/`. For each SHALL/MUST requirement: (1) extract the invariant as a single sentence; (2) construct at least one concrete input or state that would VIOLATE the invariant if the requirement is wrong or missing; (3) check whether the given scenarios would actually catch a broken implementation — i.e., would a conforming-but-wrong implementation pass all scenarios? Flag requirements whose scenarios are too weak to distinguish correct from incorrect behavior.
   >
   > For any requirement describing a stateful mechanism (e.g. retry logic, auth flows, state transitions, hooks that run in sequence), produce a trace table: columns are the relevant variables, rows are the steps. Verify the trace is consistent with what the requirement claims.
   >
   > Report findings with file:line references. Group by severity: critical, major, minor."

   **Design Quality Reviewer** (subagent_type: `Code Reviewer`) prompt:
   > "Review the design artifact at `openspec/changes/<name>/design.md`. Check: (1) every Decision section explains why that choice over alternatives — not just what was decided; (2) at least one alternative is listed per decision; (3) Risks include mitigations; (4) the design is grounded in the actual codebase (not purely theoretical). Provide specific findings with file references. Group by severity: critical, major, minor."

   **Proposal Reviewer** (subagent_type: `Code Reviewer`) prompt:
   > "Review the proposal at `openspec/changes/<name>/proposal.md`. Check: (1) the 'Why' is specific and compelling — not vague; (2) 'What Changes' lists concrete, unambiguous changes; (3) the Impact section covers all affected code, APIs, and systems. Provide specific findings with file references. Group by severity: critical, major, minor."

   **Security Design Reviewer** (subagent_type: `Security Engineer`) prompt:
   > "Review the design and spec artifacts for the `<name>` change for security concerns. Read `openspec/changes/<name>/proposal.md`, `openspec/changes/<name>/design.md`, and all spec files under `openspec/changes/<name>/specs/`. Check: (1) does the proposal identify security-sensitive systems, data flows, or user-facing inputs? (2) does the design introduce authentication/authorization patterns — are they sound? (3) are there missing security requirements in the specs (e.g., input validation, rate limiting, CSRF protection, secrets handling, privilege escalation risks)? (4) does the design's Risks section call out security-relevant trade-offs? Default to finding gaps. Provide findings with file references and severity: critical, major, minor."

   **Codex Adversarial Review** (subagent_type: `codex:codex-rescue`) prompt:
   > "Challenge the change proposal for `<name>`. Read `openspec/changes/<name>/proposal.md`, `openspec/changes/<name>/design.md`, and all spec files under `openspec/changes/<name>/specs/`. Question: (1) is the scope right — too large, too small, or missing a key concern? (2) what assumptions does this change depend on that could be wrong? (3) are there simpler approaches that were overlooked? (4) what could go wrong during implementation that isn't called out in the design risks? Default to finding problems. Report specific findings with file references and severity. Do not make any changes."

   **Documentation Compliance Reviewer** (subagent_type: `Code Reviewer`) prompt:
   > "Review `openspec/changes/<name>/tasks.md` for documentation compliance against the project rules in `CLAUDE.md`. Check: (1) if the change adds a new portal page, is there a task to update section 8 of `docs/technical-overview.md`? (2) if the change adds a new API endpoint or route module, is there a task to update section 7? (3) if the change adds a new database table or significant column change, is there a task to update section 5? Also check `openspec/changes/<name>/proposal.md` Impact section. Provide specific findings with file references. Group by severity: critical, major, minor."

   **Meta-reviewer** (subagent_type: `codex:codex-rescue`) prompt — run after primary agents complete, with findings passed in:
   > "You are a meta-reviewer. The following findings were produced by other reviewers for the `<name>` change:
   >
   > <PASTE ALL PRIMARY AGENT FINDINGS HERE>
   >
   > Read `openspec/changes/<name>/proposal.md`, `openspec/changes/<name>/design.md`, and all spec files under `openspec/changes/<name>/specs/` yourself.
   >
   > Answer one question: **what did the other reviewers miss?** Look specifically for: (1) failure modes that no reviewer traced; (2) requirements that no reviewer tested behaviorally; (3) cross-cutting concerns (error handling, observability, rollback) that were not mentioned; (4) assumptions that were accepted without being stated. Do not repeat findings already raised. Report only net-new findings with file references and severity. Do not make any changes."

   ---

   ### Implementation mode (`--implementation`)

   All prompts below begin with the `CHANGE CONTEXT` block from step 3. Replace `<CHANGE CONTEXT>` with the actual block, and `<SPECS_PATH>` with the resolved path.

   **Structural Reviewer** (subagent_type: `Code Reviewer`) prompt:
   > "<CHANGE CONTEXT>
   >
   > You are a STRUCTURAL reviewer only. Do not make behavioral claims about whether mechanisms work correctly.
   >
   > For each in-scope file, use `git diff <COMMIT_RANGE> -- <file>` to see what changed, then read the file in full with the Read tool. Also read the specs at `<SPECS_PATH>/specs/` and tasks at `<SPECS_PATH>/tasks.md`.
   >
   > Check only: (1) every spec scenario has a corresponding implementation path — find the code that implements it; (2) config key names, function names, and identifiers are consistent between spec and code; (3) all tasks marked complete have observable code changes; (4) imports, exports, and dependencies are correct; (5) no dead code, unused variables, or stale references were introduced.
   >
   > For each finding, state: **Introduced by this change** or **Pre-existing**. Only critical/major if introduced. Report with file:line references."

   **Behavioral Reviewer** (subagent_type: `Code Reviewer`) prompt:
   > "<CHANGE CONTEXT>
   >
   > You are a BEHAVIORAL reviewer only. Do not check formatting, naming consistency, or task coverage — that is handled by another reviewer.
   >
   > For each in-scope file, use `git diff <COMMIT_RANGE> -- <file>` to see what changed, then read the file in full with the Read tool. Also read the specs at `<SPECS_PATH>/specs/`.
   >
   > For each SHALL/MUST in the specs that the in-scope files implement: (1) extract the invariant as a sentence; (2) construct at least one concrete input, request, or state that would VIOLATE the invariant; (3) trace whether the implementation actually prevents the violation — follow the code path step by step.
   >
   > For any mechanism with state (retry logic, hooks that run in sequence, auth flows, queues, locks), produce a trace table: columns are the relevant variables, rows are the steps through the code. Verify the trace matches what the spec claims.
   >
   > For each finding, state: **Introduced by this change** or **Pre-existing**. Only critical/major if introduced. Report with file:line references."

   **Security Engineer** (subagent_type: `Security Engineer`) prompt:
   > "<CHANGE CONTEXT>
   >
   > Review the implementation of the `<name>` change for security issues. For each in-scope file, use `git diff <COMMIT_RANGE> -- <file>` then read in full with the Read tool. Also read specs at `<SPECS_PATH>/specs/`.
   >
   > For each finding, state: **Introduced by this change** or **Pre-existing**. Only critical/major if introduced. Pre-existing security issues belong in a separate remediation backlog — note them as informational.
   >
   > Check: auth/authz issues, injection risks, information disclosure, insecure defaults, missing input validation, secrets handling, divergence from security requirements in the specs. Provide findings with file:line references and severity."

   **Reality Checker** (subagent_type: `Reality Checker`) prompt:
   > "<CHANGE CONTEXT>
   >
   > You are a production readiness gate. Read tasks at `<SPECS_PATH>/tasks.md`, specs at `<SPECS_PATH>/specs/`. Use `git diff <COMMIT_RANGE>` then read each in-scope file with the Read tool. Only examine in-scope files.
   >
   > Default verdict: NEEDS WORK. Issue READY only if: all tasks are genuinely complete (not just checked off), the implementation does what the specs require, and no regressions were introduced by this change. List specific evidence either way."

   **Security Codex Review** (subagent_type: `codex:codex-rescue`) prompt:
   > "<CHANGE CONTEXT>
   >
   > Review the implementation for security vulnerabilities. Use `git diff <COMMIT_RANGE> -- <file>` then read each in-scope file in full with the Read tool. Also read specs at `<SPECS_PATH>/specs/`.
   >
   > For each finding, state: **Introduced by this change** or **Pre-existing**. Only critical/major if introduced.
   >
   > Focus on: injection, auth/authz flaws, information disclosure, insecure defaults, input validation gaps, CSRF, secrets handling. For each finding include the attack scenario, file:line, and fix recommendation. Do not make any changes."

   **Accessibility Auditor** (subagent_type: `Accessibility Auditor`) prompt:
   > "<CHANGE CONTEXT>
   >
   > Review the in-scope files for accessibility issues. Only examine in-scope files that are `.tsx`, `.ts`, `.css`, or template files — do NOT examine untracked files or files from other changes. Use `git diff <COMMIT_RANGE> -- <file>` then read each in-scope frontend file in full with the Read tool.
   >
   > If none of the in-scope files are frontend files, report 'No frontend changes in scope — accessibility review not applicable.'
   >
   > Check: accessible labels, form/label associations, error state announcements, focus management, WCAG AA contrast, keyboard navigation. Provide findings with file:line references and severity."

   **Adversarial Review** (subagent_type: `codex:codex-rescue`) prompt:
   > "<CHANGE CONTEXT>
   >
   > Challenge the implementation approach. Use `git diff <COMMIT_RANGE>` then read each in-scope file with the Read tool. Also read specs at `<SPECS_PATH>/specs/` and design at `<SPECS_PATH>/design.md`.
   >
   > Question: (1) is the chosen approach right — what would a simpler alternative look like? (2) what assumptions does it depend on that could be wrong? (3) where does the design fail under real-world conditions (concurrent users, partial failures, environment drift)? (4) what failure mode would only appear in production, not in tests? Default to finding problems. Report with file:line references and severity. Do not make any changes."

   **Meta-reviewer** (subagent_type: `codex:codex-rescue`) prompt — run after primary agents complete, with findings passed in:
   > "You are a meta-reviewer. The following findings were produced by other reviewers for the `<name>` change:
   >
   > <PASTE ALL PRIMARY AGENT FINDINGS HERE>
   >
   > Read the specs at `<SPECS_PATH>/specs/` and the in-scope files listed below yourself using the Read tool:
   > <IN_SCOPE_FILES>
   >
   > Answer one question: **what did the other reviewers miss?** Look specifically for: (1) behavioral failure modes no reviewer traced — pick a SHALL/MUST that no reviewer tested with a concrete violating input and test it yourself; (2) cross-cutting concerns (error handling, observability, rollback, concurrent access) not mentioned by any reviewer; (3) assumptions accepted without being stated; (4) a scenario where the implementation is spec-compliant but still wrong. Do not repeat findings already raised. Report only net-new findings with file:line references and severity. Do not make any changes."

   ---

   d. **Collect findings.** For the fix loop:
      - In implementation mode: only count findings marked **Introduced by this change** as critical or major. Pre-existing findings do not count toward round totals and are not auto-fixed.
      - In artifacts mode: count all critical and major findings.

      Append to `round_log`:
      ```
      Round <round>: <N_critical> critical, <N_major> major, <N_minor> minor (introduced); <N_preexisting> pre-existing surfaced
      ```

   e. **Exit conditions (check before fixing):**
      - If zero critical and zero major findings: mark as CLEAN, exit loop → go to step 5.
      - If `round == MAX_ROUNDS`: exit loop → go to step 5 (report remaining issues).

   f. **Apply fixes for all critical and major introduced findings** directly (using Edit/Write tools — do not spawn a subagent for this):
      - For each finding, read the relevant file, apply the targeted fix, and log it:
        `Round <round> fix: <brief description> — <file:line>`
      - Apply only what the finding specifically identifies. Do not expand scope.
      - Minor findings and pre-existing findings: do not fix. Surface them in the final report.

   g. `round++` → return to step b.

5. **Present consolidated report**

   ```
   ## Review Summary — <name> (<mode>)

   | Round | Critical | Major | Minor | Pre-existing | Status        |
   |-------|----------|-------|-------|--------------|---------------|
   | 1     | N        | N     | N     | N            | fixes applied |
   | 2     | N        | N     | N     | N            | fixes applied |
   | ...   |          |       |       |              |               |
   | final | N        | N     | N     | N            | CLEAN / open  |

   ### Fixes Applied
   - Round 1: <fix description> — <file:line>
   - ...

   ### Remaining Findings (introduced by this change)
   (critical/major if max rounds reached; all minors)

   ### Pre-existing Issues (not introduced by this change — remediate separately)
   (list here for awareness)
   ```

6. **Output the next step** (do not ask — the next step is fixed by the lifecycle)

   The next-step block must be a literal fenced code block the user can copy and paste. Do NOT use inline code or prose — always use the block format below.

   **Artifacts mode** (review ran before implementation):
   ```
   ---
   Next step — run in this pane:
   /opsx:apply <name>
   ```
   Do NOT suggest opening the GitHub issue (already done by `opsx:propose`) and do NOT suggest `/opsx:worktree` (the worktree is already set up — the review is running inside it).

   **Implementation mode** (review ran after apply):
   ```
   ---
   Next step — run in this pane:
   /opsx:archive <name>
   ```

7. **Autonomous tail-call (guarded)**

   This step fires only when ALL of the following are true:
   - Steps 0–5 completed without error (no early exit)
   - `OPSX_AUTONOMY_DISABLED` is NOT set to `1`

   If `OPSX_AUTONOMY_DISABLED=1`: print to stderr `opsx-review: OPSX_AUTONOMY_DISABLED set — not chaining to next phase` and exit normally.

   If any earlier step exited with an error: print to stderr `opsx-review: exited with error — not chaining to next phase` and exit normally.

   **CLEAN outcome (zero critical, zero major introduced findings after the final round):**

   Before chaining: write `.opsx-state.json` to record the clean result (so auto-advance can detect the correct phase if this tail-call is interrupted or OPSX_AUTONOMY_DISABLED fires in the chained skill). Read the existing `.opsx-state.json` BEFORE writing to extract the current `retry_budget.peer_bus_emit_fails` value — use the extracted value in the write; default to `0` only if the file does not exist or is corrupt. Always set all required top-level fields explicitly — do not rely solely on preserving existing fields, as the file may not exist or may have been written by a different change:
   - **Artifacts mode CLEAN**: `change: "<change-name>"`, `phase: "review-artifacts-complete-clean"`, `pending_decision_request: null`, `idle_tracking: { first_idle_at: null }`, `updated_at: "<ISO-8601>"`, `retry_budget: <preserve existing or default {peer_bus_emit_fails: 0}>`
   - **Implementation mode CLEAN**: `change: "<change-name>"`, `phase: "review-impl-complete-clean"`, `pending_decision_request: null`, `idle_tracking: { first_idle_at: null }`, `updated_at: "<ISO-8601>"`, `retry_budget: <preserve existing or default {peer_bus_emit_fails: 0}>`

   Print one line to stderr: `opsx-review: CLEAN — chaining to <next-skill>`

   - **Artifacts mode CLEAN** → invoke `/opsx:apply <change>` in the same turn.
   - **Implementation mode CLEAN** → invoke `/opsx:archive <change>` in the same turn.

   **NON-CLEAN outcome (critical or major introduced findings remain after MAX_ROUNDS):**

   Do NOT tail-call. Instead:

   If bus is available:
   1. Generate a new UUID as `requestId`.
   2. Read-modify-write `.opsx-state.json` BEFORE emitting (write-before-emit ordering) — preserve all top-level fields. Use the phase enum matching the current mode: `"review-artifacts-complete-decisions"` for artifacts mode, `"review-impl-complete-decisions"` for implementation mode:
      ```json
      {
        "change": "<change-name>",
        "phase": "<review-artifacts-complete-decisions OR review-impl-complete-decisions>",
        "updated_at": "<ISO-8601>",
        "pending_decision_request": {
          "requestId": "<uuid>",
          "emitted_at": "<ISO-8601>",
          "originating_phase": "<same as phase above>",
          "options": [
            {"label": "fix-and-continue", "description": "<describe what re-reviewing and fixing entails>"},
            {"label": "archive-anyway", "description": "<describe what archiving despite open findings means>"}
          ]
        },
        "idle_tracking": { "first_idle_at": null },
        "retry_budget": {
          "peer_bus_emit_fails": <existing value or 0>
        }
      }
      ```
      Read the existing `.opsx-state.json` BEFORE writing to extract the current `retry_budget.peer_bus_emit_fails` value (default `0` if the file does not exist or is corrupt). Use the extracted value — never reset it. If `.opsx-state.json` does not exist or is corrupt, create it fresh with all fields with `peer_bus_emit_fails: 0`. Never write only `pending_decision_request` — auto-advance validates `change` at step 5 and will treat a partial file as corrupt.
   3. Emit `workflow-event` to `claude-main` via an explicit `send_message({...})` call. Use the short `phase` form matching the spec enum: artifacts mode → `"review-artifacts"`, implementation mode → `"review-implementation"`. The `body` MUST be a JSON object literal — NOT a stringified JSON value — otherwise the coordinator rejects with `invalid_workflow_event_body: workflow-event body must be a JSON object`. `replyTo` MUST live ONLY inside `body`, never as a top-level argument to `send_message`:
      ```
      send_message({
        sessionToken: <sessionToken from context>,
        to: "claude-main",
        kind: "workflow-event",
        body: {
          event: "decision-request",
          change: "<change-name>",
          phase: "<review-artifacts OR review-implementation>",
          question: "<one-line human-readable summary of the scope decision>",
          options: [
            {label: "fix-and-continue", description: "<describe what re-reviewing and fixing entails>"},
            {label: "archive-anyway", description: "<describe what archiving despite open findings means>"}
          ],
          context: {
            findings_summary: "<brief summary, ≤ 500 chars>",
            introduced_totals: {critical: <N>, major: <N>, minor: <N>},
            review_artifact_path: "openspec/changes/<name>/"
          },
          requestId: "<same uuid>",
          replyTo: "frontend"   // this pane's area: one of "frontend" | "backend" | "misc" — never "main"
        }
      })
      ```
      Option `label` values MUST be unique within the array. `replyTo` MUST be this pane's own area name from the allowlist `{frontend, backend, misc}` — do NOT set it to a different area, and never to `main`.

   4. **If `send_message` fails** (transport error or named error after recovery): roll back `.opsx-state.json` by setting `pending_decision_request` to `null` and `idle_tracking: { first_idle_at: null }` (preserve `phase` as the `*-complete-decisions` value, `retry_budget`, and all other fields). The phase remaining as `*-complete-decisions` with null pending means the next auto-advance tick re-enters `emit-decision-request` with its own retry budgeting. Increment `retry_budget.peer_bus_emit_fails` in the rolled-back write. Exit without tail-calling.

   5. Exit without tail-calling (on successful emit).

   If bus is unavailable: write `.opsx-state.json` with `phase` set to the `*-complete-decisions` value and `pending_decision_request` pre-populated with `requestId: null` and the full question/options/context from the review findings (so auto-advance can reconstruct the emit payload when the bus recovers — without needing to re-run the review). Use `emitted_at: null` to mark the request as staged-but-not-emitted:
   ```json
   {
     "change": "<change-name>",
     "phase": "<review-artifacts-complete-decisions OR review-impl-complete-decisions>",
     "updated_at": "<ISO-8601>",
     "pending_decision_request": {
       "requestId": null,
       "emitted_at": null,
       "originating_phase": "<same as phase above>",
       "options": [
         {"label": "fix-and-continue", "description": "<describe what re-reviewing and fixing entails>"},
         {"label": "archive-anyway", "description": "<describe what archiving despite open findings means>"}
       ],
       "question": "<one-line human-readable summary>",
       "context": {
         "findings_summary": "<brief summary, ≤ 500 chars>",
         "introduced_totals": {"critical": N, "major": N, "minor": N},
         "review_artifact_path": "openspec/changes/<name>/"
       }
     },
     "idle_tracking": { "first_idle_at": null },
     "retry_budget": { "peer_bus_emit_fails": <existing value or 0> }
   }
   ```
   Then print the pending decision summary to stdout as a free-text block and exit without tail-calling.

**Guardrails**
- Always resolve specs path and commit range in step 3 before spawning agents — never guess
- Always run ALL primary review agents in parallel, then run the meta-reviewer sequentially with their findings
- The structural reviewer and behavioral reviewer must never be collapsed into one — keep them separate
- Apply fixes using Edit/Write — do not spawn a subagent for fixes
- Only fix critical and major **introduced** findings; pre-existing and minor go in the report only
- Do not expand fix scope beyond what the finding specifically identifies
- If the change name cannot be inferred, ask before proceeding

ARGUMENTS: $ARGUMENTS
