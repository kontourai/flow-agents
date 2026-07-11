---
name: "learning-review"
description: "Capture delivery decisions, outcomes, and routed follow-up. Records Builder publish-learn learning evidence in trust.bundle."
---

# Learning Review

## Role

This is a Builder step skill.

Learning Review records what the delivery outcome taught us and where any
correction belongs. It does not rewrite history, implement fixes, or declare a
failed outcome successful.

## Binding

| Context | Binding | Flow expectations |
| --- | --- | --- |
| Active Builder run | Parent `builder.build` projection at composed `builder.publish-learn` step `learn` | `decision-evidence` and `learning-evidence` |
| Standalone invocation | No Flow binding | No workflow mutation. |

For an active run, inspect the binding first:

```bash
flow-agents workflow status --session-dir <session-dir> --json
```

Public status reports the parent definition as `builder.build`. Only that parent
run at `learn`, whose Flow Definition composes the step from
`builder.publish-learn`, may publish workflow evidence. A standalone review
produces its local record only.

## Inputs

- Original intent, acceptance evidence, confidence report, and release decision.
- Observed outcomes from `RepositoryAdapter`, `CheckProvider`, `ReleaseProvider`,
  and `DeployProvider` when those providers exist.
- Incidents, user feedback, review findings, operational observations, and
  durable documentation decisions.

## Learning Work

1. Compare intended and observed outcomes. Separate observed facts from
   interpretation.
2. Record delivery decisions and whether a correction is needed. A clean result
   may record that no correction is needed; do not invent a lesson.
3. When a correction is needed, name the gap, the affected workflow or product
   area, and a durable follow-up, deferral condition, accepted decision, or
   explicit rationale for no change.
4. Give each correction a stable identifier, owner or ownership gap, target
   destination, evidence, disposition, and follow-up state. Route product work
   to the backlog, workflow defects to the owning workflow, regression risks to
   tests, durable operating knowledge to the knowledge system, and binding
   decisions or changed contracts to documentation or an ADR.
5. Record follow-up creation or linkage as observed evidence. A recommendation
   without a durable destination remains open; do not report it as captured.
6. Preserve `NOT_VERIFIED` for outcomes that could not be observed. Do not infer
   deployment, release, provider, or user outcomes from local completion alone.
7. Give `decision-evidence` and `learning-evidence` independent verdicts. A
   complete decision record can pass while learning follow-up remains failed or
   `NOT_VERIFIED`.
8. On a matching active run, publish both expectations through the public CLI:

```bash
flow-agents workflow evidence --session-dir <session-dir> \
  --expectation decision-evidence \
  --status <pass|fail|not_verified> \
  --summary "Delivery decisions and unresolved gaps are recorded." \
  --evidence-ref-json '{"kind":"artifact","file":"<session-dir>/learning.json","summary":"Recorded delivery decisions, correction state, and routing."}'

flow-agents workflow evidence --session-dir <session-dir> \
  --expectation learning-evidence \
  --status <pass|fail|not_verified> \
  --summary "Observed outcomes and learning follow-up are recorded." \
  --evidence-ref-json '{"kind":"artifact","file":"<session-dir>/learning.json","summary":"Observed outcomes, follow-up routing, and unresolved gaps."}'
```

## Output

Record scope, intended and observed outcomes, decisions, facts, interpretation,
correction state, `NOT_VERIFIED` gaps, and follow-up routing as the
`decision-evidence` and `learning-evidence` slices in `trust.bundle`.
Corrections include their identifier, owner, destination, evidence, disposition,
and durable link when one was created.

For a matching active run, publish both `decision-evidence` and
`learning-evidence` from those slices. These claims record closeout evidence;
they do not erase open follow-up work or authorize an external operation.
