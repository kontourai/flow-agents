---
name: "design-probe"
description: "Generic one-question-at-a-time design probing interview for turning unclear goals, designs, or workflow states into shared understanding before planning or execution."
---

# Design Probe

Use `design-probe` when a goal, design, workflow route, implementation boundary, acceptance criterion, or recovery path is not clear enough to plan or execute responsibly.

This skill is generic. It is not Builder Kit-only. Builder Kit uses the flow step name `design-probe` during pickup and guided build workflows, but the same probing contract applies to any project, feature, architecture, product idea, or implementation handoff that needs alignment.

This skill is modeled after Matt Pocock's `grill-me`: interview the user relentlessly about the relevant plan or design until shared understanding exists, walk the design tree branch by branch, provide a recommended answer for each question, ask one question at a time, and explore the codebase or local docs instead of asking when the answer is discoverable.

## Contract

- Explore first: inspect available local docs, plans, artifacts, contracts, code, tests, issue text, and prior decisions before asking the user when the answer is discoverable.
- Stay grounded: cite the local sources or code paths that shaped the question when they matter.
- Walk the design tree branch by branch: resolve dependencies between decisions one-by-one before moving to the next branch instead of mixing independent concerns.
- Be relentless about ambiguity: keep probing fuzzy goals, overloaded terms, implicit non-goals, missing constraints, and weak success signals until they are resolved or explicitly accepted as gaps.
- Ask exactly one alignment question at a time.
- Include a recommended answer with every question and briefly explain why it is recommended.
- Make the recommendation actionable enough that the user can accept it directly.
- Record decisions, unresolved questions, accepted gaps, and planning readiness as the interview progresses.
- Stop when shared understanding exists, or when the remaining uncertainty is explicitly recorded as an accepted gap.
- Do not silently convert uncertainty into implementation work.

## When To Use

Use this skill for:

- Ambiguous product or feature goals.
- Conflicting requirements or unclear non-goals.
- Missing acceptance criteria or unclear evidence expectations.
- Architecture or workflow decisions that block planning.
- Direct primitive recovery when upstream context or state is missing.
- Guided workflow next-step selection when artifacts do not clearly identify whether to ask, plan, execute, verify, or stop.

Do not use this skill to replace implementation planning, backlog shaping, verification, or release review. Use it only until the design decision surface is aligned enough for the next workflow primitive.

## Discovery Before Asking

Before asking the first question:

1. Read the user's request and identify the decision branch that blocks progress.
2. Search local context that could answer it, such as `README`, `CONTEXT.md`, `docs/`, `context/contracts/`, relevant skills, active workflow artifacts, schemas, tests, and nearby implementation files.
3. Prefer existing project vocabulary and documented decisions over inventing new terms.
4. If local evidence resolves the branch, record the inferred decision and move to the next branch.
5. Ask only when the branch remains ambiguous, contradictory, risky, or value-laden.

## Interview Loop

For each unresolved branch:

1. State the branch being resolved in one short sentence.
2. Ask exactly one question.
3. Provide a recommended answer in the same message.
4. Explain the practical consequence of accepting the recommendation.
5. Wait for the user's answer before asking another question.
6. Record the outcome before continuing.

Question format:

```markdown
Question: <one alignment question>

Recommended answer: <specific answer the user can accept>

Why: <brief reason and consequence>
```

If the user answers with a new ambiguity, treat that as the next branch. If the user accepts the recommendation, record it as a decision and continue.

## Records

Maintain a compact running record in the active artifact or conversation when no artifact exists:

- `decisions`: choices that are aligned or locally inferable.
- `unresolved_questions`: questions still blocking planning or execution.
- `accepted_gaps`: uncertainties the user explicitly accepts, including the consequence.
- `planning_readiness`: one of `ready`, `needs_more_probe`, or `accepted_gap_ready`.
- `next_action`: the recommended next workflow step, such as `shape`, `plan-work`, `execute-plan`, `verify-work`, `needs_user`, or `stop`.

When workflow artifacts exist, update the appropriate session, handoff, Probe record, or planning artifact according to the local artifact contract. Do not invent a project-specific storage format when the repository already defines one.

## Stop Conditions

Stop probing when one of these is true:

- Shared understanding exists and the next action is clear.
- The user explicitly accepts a gap and its consequence, and the next action can proceed with that gap recorded.
- The next action is to stop because the goal is out of scope, not worth pursuing, or blocked by an external dependency.

Before stopping, summarize:

- Decisions made.
- Remaining unresolved questions, if any.
- Accepted gaps, if any.
- Planning readiness.
- Recommended next action.

## Gate Claims: Builder Kit Design-Probe Step

When `design-probe` runs at the Builder Kit `design-probe` flow step and the probe reaches a stop condition with shared understanding or accepted gaps, record the gate claims before handing off to `plan-work`.

This applies whether the probe is run directly (generic) or as part of a Builder Kit productized flow. The `pickup-probe` specialization owns the same two claims when it runs instead.

**Claim 1 — Pickup readiness** (probe passed, goal fit and scope confirmed):

```bash
npm run workflow:sidecar -- record-gate-claim .kontourai/flow-agents/<slug> \
  --expectation pickup-probe-readiness \
  --status pass \
  --summary "Design probe passed: goal fit confirmed, scope aligned, planning readiness verified." \
  --evidence-ref-json '{"kind":"artifact","file":".kontourai/flow-agents/<slug>/<slug>--<artifact>.md","summary":"Design-probe artifact with decisions, accepted gaps, and planning readiness."}'
```

**Claim 2 — Probe decisions captured**:

```bash
npm run workflow:sidecar -- record-gate-claim .kontourai/flow-agents/<slug> \
  --expectation probe-decisions-or-accepted-gaps \
  --status pass \
  --summary "Probe decisions recorded: decisions made, unresolved questions explicit, planning readiness confirmed." \
  --evidence-ref-json '{"kind":"artifact","file":".kontourai/flow-agents/<slug>/<slug>--<artifact>.md","summary":"Design-probe artifact with decisions and accepted gaps."}'
```

Record both claims when shared understanding exists and the next action is `plan-work` or equivalent. Use `--status fail` when stopping due to an unresolved blocker. Skip these claims entirely when `design-probe` is used outside a Builder Kit flow (no active `builder.build` flow step in `current.json`).

## Boundaries

- Do not ask multiple questions in one turn.
- Do not ask for information already discoverable from local docs, code, tests, schemas, or workflow artifacts.
- Do not broaden the probe into unrelated architecture review, backlog shaping, or implementation.
- Do not treat Builder Kit terminology as required outside Builder Kit workflows.
- Do not overwrite downstream workflow authority: if another contract owns planning, verification, release, or gate semantics, hand off to that contract once probing is complete.
