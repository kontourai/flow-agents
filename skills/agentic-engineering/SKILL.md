---
name: agentic-engineering
description: "Eval-first execution, task decomposition, and cost-aware model routing for AI-driven development workflows."
---

# Agentic Engineering

Principles for AI-driven development: eval-first loops, disciplined decomposition, and cost-aware model selection.

## Eval-First Loop

Every implementation follows this cycle:

1. **Define eval** — write the acceptance criteria as a runnable check (test, script, assertion)
2. **Run baseline** — capture current behavior against the eval
3. **Implement** — make the change
4. **Re-run eval** — verify improvement
5. **Check regressions** — run the full suite, not just the new eval

Never ship without steps 4-5. If you can't define an eval, the requirement isn't clear enough.

## 15-Minute Unit Rule

Decompose every task into units where each:
- Is **independently verifiable** — has its own eval or test
- Has a **single dominant risk** — one thing that could go wrong
- Has a **clear done condition** — unambiguous pass/fail
- Takes **~15 minutes** of focused agent work

If a unit can't be verified independently, it's too coupled. If it has multiple risks, split it.

## Model Routing

Match model tier to task complexity:

| Tier | Model class | Use for |
|------|-------------|---------|
| Fast | Haiku | Boilerplate, narrow edits, formatting, simple transforms |
| Standard | Sonnet | Implementation, refactors, test writing, code review |
| Reasoning | Opus | Architecture decisions, root-cause analysis, complex debugging |

### Cost Discipline
- Start at the lowest tier that could work
- Escalate only when the lower tier fails with a **clear reasoning gap** (not just a wrong answer — a structural inability to solve the problem)
- Document the escalation reason: "Sonnet couldn't hold the full dependency graph → escalated to Opus"
- Never use Opus for tasks Sonnet handles correctly

## Session Strategy

- **Continue** session for coupled units within the same phase
- **Fresh** session after phase transitions (plan → implement, implement → verify)
- **Compact** after milestones — summarize context, drop intermediate artifacts

## Review Focus for AI-Generated Code

AI code passes syntax checks easily but fails on subtler dimensions. Prioritize reviewing:

- **Invariants** — are assumptions about state actually enforced?
- **Edge cases** — empty inputs, boundary values, concurrent access
- **Error boundaries** — does the error surface or get swallowed?
- **Security assumptions** — auth checks, input sanitization, secret handling
- **Hidden coupling** — does this change break something non-obvious elsewhere?
