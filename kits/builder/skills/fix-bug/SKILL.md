---
name: "fix-bug"
description: "Bug fix orchestrator — diagnose → plan-work → execute-plan → review-work → verify-work → loop. Diagnosis phase is unique to bugs, then chains the same primitives."
---

# Bug Fix

Diagnose a bug, then chain the same plan → execute → verify loop. The diagnosis phase is what makes this different from deliver.

## Agents

Inherited from primitives + diagnosis:

| Agent | Used by |
|---|---|
| tool-planner | diagnosis + plan-work |
| tool-worker (x4) | execute-plan |
| tool-code-reviewer | review-work |
| tool-security-reviewer | review-work (conditional — security-sensitive changes) |
| tool-verifier | verify-work |
| tool-playwright | diagnosis (reproduce) + verify-work |

## Model Routing

Delegates are spawned with an explicit model override resolved from
`.datum/config.json` via `npx @kontourai/datum resolve <role> --json` — see
`context/contracts/execution-contract.md` § Delegation: Model Routing:

| Delegate | Role |
|---|---|
| tool-worker | `delegate-mechanical` for fully-specified mechanical slices, `delegate-implementation` for precisely-planned implementation, `delegate-design` when a slice needs design latitude |
| tool-planner | `delegate-design` |
| tool-code-reviewer / tool-security-reviewer | `delegate-implementation` by default, raised to the worker's tier when higher — never below the tier of the checked work (Goodhart guard) |
| tool-verifier / tool-playwright | `delegate-implementation` by default, raised to the worker's tier when higher — never below the tier of the checked work (Goodhart guard) |

On a review/verify gate failure, re-dispatch the fix one tier higher and record
the escalation (contract § Escalation on gate failure). Fallback: inherit the
session model when datum/config is absent, noted in the artifact.

## Orchestrator Rule

You never use `read`, `glob`, `grep`, or `code` on source files. All codebase analysis goes through tool-planner. All review goes through review-work. All verification goes through tool-verifier or tool-playwright.

## Input

- **Bug report**: screenshot, error log, user description, or all three
- **Directory**: working directory

## Session File

Filename: `<branch>--fix-bug-<slug>.md`

```markdown
# BUG: <one-liner>

branch: <branch>
worktree: <worktree>
created: <date>
status: diagnosing | planning | fixing | verifying | resolved
type: fix-bug
iteration: 0

## Bug Report

Source: screenshot | error log | user description
<original report, pasted verbatim>

## Diagnosis

Root cause from tool-planner.

## Plan

(populated by plan-work)

## Execution Progress

(populated by execute-plan)

## Verification Report

(populated by verify-work)

## History

- iteration 1: partial — fix applied but regression in sidebar
- iteration 2: pass — bug fixed, no regressions
```

`<branch>` is the branch recorded in `state.json`'s `branch` field (`ensure-session` derives `agent/<actor>/<slug>`; an explicit `--branch` flag overrides on a new session). `ensure-session` only records the name — creating and checking out the actual git branch/worktree remains this skill's responsibility.

## Workflow

### 1. Create session file

Paste the bug report verbatim. Set `status: diagnosing`.

### 2. Diagnose (unique to bugs)

1. **Reproduce** (if visual) — delegate to tool-playwright to confirm the bug is visible. Screenshot the broken state.
2. **Find root cause** — delegate to tool-planner:
   ```
   Bug: <description>
   Reproduction: <steps or screenshot evidence>
   Directory: <working directory>
   todo_file: <session file path>
   Find the root cause and propose a fix plan.
   ```
3. Read the diagnosis from tool-planner's output
4. Paste into session file `## Diagnosis`
5. Present to user: "Here's what's broken and how I'd fix it. Agree?"
6. On approval → proceed to plan

### 3. Plan (plan-work)

Invoke plan-work with: diagnosis + fix goal, directory, session file path.

### 4. Execute (execute-plan)

Invoke execute-plan with the plan artifact path and session file path.

### 5. Review (review-work)

Invoke `review-work` with the session file path. It must delegate to `tool-code-reviewer`, and to `tool-security-reviewer` when security triggers are present. CRITICAL/HIGH findings block and loop back to Execute unless explicitly accepted.

### 6. Verify (verify-work)

Invoke verify-work with the session file path. tool-verifier must verify:
1. **Bug is fixed** — the specific issue from the report
2. **No regressions** — build passes, existing tests pass, related functionality works

### 7. Route on verdict

- **All PASS** → resolve
- **Any FAIL** → loop
- **Any NOT_VERIFIED** → surface to user

### 8. Loop (on failure)

1. Summarize what failed
2. Increment `iteration`
3. Re-invoke plan-work with: original diagnosis + failure summary → updated fix plan
4. Back to step 4

### 9. Resolve

1. Include verification report verbatim
2. Show before/after evidence (screenshots if visual)
3. `git diff --stat`
4. Set `status: resolved`

{context?}
