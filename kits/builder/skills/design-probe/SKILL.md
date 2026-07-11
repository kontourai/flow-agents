---
name: "design-probe"
description: "Generic one-question-at-a-time design probe for turning unclear goals, designs, and handoffs into shared understanding."
---

# Design Probe

Use `design-probe` when a goal, design, implementation boundary, acceptance criterion, workflow route, or recovery path is not clear enough to plan or execute responsibly.

## Role And Binding

- **Role:** standalone shared alignment primitive.
- **Binding:** none. This skill is not a Builder step producer.
- **Produces:** a compact decision record in the caller's existing artifact or conversation; no prescribed Builder artifact or expectation.
- **Standalone no-run behavior:** always run as an independent probe. Do not start, inspect, advance, or record evidence for any Builder flow.

## Contract

- Explore available docs, plans, artifacts, contracts, code, tests, issue text, and prior decisions before asking for discoverable information.
- Resolve one decision branch at a time. Ask exactly one alignment question per turn, include a recommended answer, and wait for the response.
- Keep probing fuzzy goals, overloaded terms, implicit non-goals, missing constraints, and weak success signals until they are resolved or explicitly accepted as gaps.
- Do not silently turn uncertainty into implementation work.
- Do not replace backlog shaping, implementation planning, verification, release review, or any flow-specific producer.

## Model Routing

When delegating alignment work, resolve `delegate-design` from `.datum/config.json`. If unavailable, inherit the session model and state the fallback in the decision record.
Apply the routing and escalation contract in `context/contracts/execution-contract.md`.

## When To Use

Use this primitive for ambiguous product or feature goals, conflicting requirements, missing acceptance criteria, architecture decisions, unclear recovery paths, and uncertain next actions. It may be called by a specialized workflow skill, but it owns no workflow gate or claim procedure.

## Discovery

1. Identify the decision branch that blocks progress.
2. Search local context for the answer and prefer existing vocabulary and documented decisions.
3. Record an inferred decision when evidence resolves the branch.
4. Ask only when the decision remains ambiguous, contradictory, risky, or value-laden.

## Interview Loop

For each unresolved branch:

1. State the branch in one short sentence.
2. Ask one question.
3. Give a specific recommended answer and its practical consequence.
4. Wait for the answer.
5. Record the decision, unresolved question, or accepted gap before moving on.

Use this format:

```markdown
Question: <one alignment question>

Recommended answer: <specific answer the user can accept>

Why: <brief reason and consequence>
```

## Decision Record

Maintain, in an existing caller artifact when one exists:

- decisions
- unresolved questions
- accepted gaps and consequences
- planning readiness: `ready`, `needs_more_probe`, or `accepted_gap_ready`
- recommended next action

For a durable, reusable domain decision, follow the repository's vocabulary and decision-record contract. Keep transient planning choices and open questions in the caller's working artifact.

## Stop

Stop when shared understanding exists, an explicit accepted gap permits the next action, or the correct next action is to stop. Summarize decisions, unresolved questions, accepted gaps, readiness, and the recommended next action.

## Boundaries

- Do not ask multiple questions in one turn.
- Do not ask for information already discoverable from local context.
- Do not broaden into unrelated architecture review or implementation.
- Do not use Builder terminology as a prerequisite for this primitive.
- Do not create or record Builder claims, expectation evidence, or flow state.
