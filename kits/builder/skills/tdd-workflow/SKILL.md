---
name: "tdd-workflow"
description: "Test-driven development — RED → GREEN → REFACTOR with git checkpoints. Wraps plan-work → execute-plan → review-work → verify-work with test-first constraints and coverage gates."
---

# TDD Workflow

Test-driven development orchestrator. Wraps the standard plan → execute → verify chain with test-first constraints.

## When to Activate

- User says "use TDD", "test-driven", "write tests first", "TDD"
- User asks to build something and mentions test coverage requirements

## Agents

Same as deliver (inherited from primitives):

| Agent | Used by |
|---|---|
| tool-planner | plan-work (with TDD constraints) |
| tool-worker (x4) | execute-plan (tests first, then implementation) |
| tool-code-reviewer | review-work |
| tool-security-reviewer | review-work (conditional) |
| tool-verifier | verify-work (with coverage check) |
| tool-playwright | verify-work (if UI) |

## Model Routing

Delegates are spawned with an explicit model override resolved from
`.datum/config.json` via `npx @kontourai/datum resolve <role> --json` — see
`context/contracts/execution-contract.md` § Delegation: Model Routing:

| Delegate | Role |
|---|---|
| tool-worker | `delegate-mechanical` for fully-specified mechanical slices, `delegate-implementation` for precisely-planned implementation (RED/GREEN/REFACTOR), `delegate-design` when a slice needs design latitude |
| tool-planner | `delegate-design` |
| tool-code-reviewer / tool-security-reviewer | `delegate-implementation` by default, raised to the worker's tier when higher — never below the tier of the checked work (Goodhart guard) |
| tool-verifier / tool-playwright | `delegate-implementation` by default, raised to the worker's tier when higher — never below the tier of the checked work (Goodhart guard) |

On a review/verify gate failure, re-dispatch the fix one tier higher and record
the escalation (contract § Escalation on gate failure). Fallback: inherit the
session model when datum/config is absent, noted in the artifact.

## Orchestrator Rule

Same as deliver: you never touch source files. You coordinate the primitives with TDD-specific context.

## Workflow

### 1. Create session file

Filename: `<branch>--tdd-<slug>.md`
Set `status: planning`, `type: tdd`, `iteration: 0`

### 2. Plan (plan-work with TDD constraint)

Invoke plan-work with additional constraint:
```
Constraint: TEST-FIRST DEVELOPMENT
- Plan MUST include test files as separate tasks in Wave 1
- Each feature task must have a corresponding test task that precedes it
- Test tasks specify: test file path, test cases to write, expected failures
- Implementation tasks specify: which tests they make pass
- Include a final "coverage check" task
```

Present plan to user. Get approval.

### 3. Execute RED phase

Invoke execute-plan for Wave 1 only (test tasks):
- tool-worker writes test files
- After Wave 1 completes, run the tests — they MUST fail (RED)
- If tests pass (no RED state), the tests are wrong — flag to user
- Git checkpoint: `test: add failing tests for <feature>`

### 4. Execute GREEN phase

Invoke execute-plan for Wave 2 (implementation tasks):
- tool-worker writes minimal code to make tests pass
- After Wave 2 completes, run the tests — they MUST pass (GREEN)
- If tests still fail, loop: re-invoke execute-plan with failure context
- Git checkpoint: `feat: implement <feature> (tests passing)`

### 5. Execute REFACTOR phase

Invoke execute-plan for Wave 3 (refactor tasks, if any):
- tool-worker improves code quality while keeping tests green
- After Wave 3, run tests again — must still pass
- Git checkpoint: `refactor: clean up <feature>`

### 6. Review (review-work)

Invoke `review-work` after GREEN/REFACTOR and before verification. Review findings must be fixed, accepted, deferred, or marked false positive before delivery.

### 7. Verify (verify-work with coverage gate)

Invoke verify-work with additional context:
```
Additional verification: Check test coverage.
Run coverage command and verify >= 80% on changed files.
Include coverage % in the verification report.
If coverage < 80%, verdict is FAIL with coverage gap details.
```

### 8. Route on verdict

Same as deliver:
- **Clean review + all PASS + coverage >= 80%** → deliver
- **Any FAIL or coverage < 80%** → loop (re-plan failing items)
- **NOT_VERIFIED** → surface to user

### 9. Deliver

Same as deliver, plus:
- Report TDD cycle summary: RED → GREEN → REFACTOR with checkpoint SHAs
- Report final coverage %

## Session File Format

```markdown
# TDD: <Goal one-liner>

branch: <branch>
created: <date>
status: planning | red | green | refactor | verifying | delivered
type: tdd
iteration: 0
coverage_target: 80

## Plan
(from plan-work)

## RED Phase
- Tests written: <list>
- All failing: YES/NO
- Checkpoint: <SHA>

## GREEN Phase
- Implementation: <list>
- All passing: YES/NO
- Checkpoint: <SHA>

## REFACTOR Phase
- Changes: <list>
- Tests still passing: YES/NO
- Checkpoint: <SHA>

## Verification Report
(from verify-work)

## History
- iteration 1: RED ✓, GREEN ✓, REFACTOR ✓, coverage 85%
```

`<branch>` is the branch recorded in `state.json`'s `branch` field (`ensure-session` derives `agent/<actor>/<slug>`; an explicit `--branch` flag overrides on a new session). `ensure-session` only records the name — creating and checking out the actual git branch/worktree remains this skill's responsibility.

{context?}
