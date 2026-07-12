---
name: "idea-to-backlog"
description: "Turn raw product or technical ideas into a shaped, prioritized, provider-neutral executable backlog before implementation starts."
---

# Idea To Backlog

Convert raw ideas into shaped, prioritized, executable work without starting implementation.

## Role And Binding

- **Role:** canonical Builder shape-step producer.
- **Binding:** `builder.shape` steps `shape`, `breakdown`, and `file-issues`.
- **Produces:** the `trust.bundle` shaping slices for an active matching run: `shaped-problem`, `shaped-outcome`, `shaped-constraints`, `shaped-non-goals`, `shaped-success`, `shaped-risk`, optional `open-decisions`, `slices-defined`, and `work-items-filed`.
- **Standalone no-run behavior:** create a local shaping artifact or return the shaped backlog to the caller. Do not start a Builder run, record Builder evidence, or imply that any Builder gate passed.

## Contract

- Produce durable reasoning before creating executable work items.
- Do not write production code or invoke downstream build, review, verification, or release skills.
- Keep distinct ideas separate unless a shared outcome, hard dependency, or sequencing reason justifies a bundle.
- Stop after shaping unless the user explicitly asks to continue with another workflow.
- Treat provider work items as an execution queue, not as the sole reasoning store.

## Provider Boundaries

Use configured capabilities rather than provider-specific commands or data shapes:

- `BoardProvider` supplies candidate queue, priority, milestone, and board state.
- `WorkItemProvider` creates or updates executable work items and records their references.
- `RepositoryAdapter` supplies repository identity, target revision, and source context.
- `AssignmentProvider` may provide ownership context; shaping does not claim work.

GitHub is only an optional adapter example. Do not require GitHub issues, Projects, labels, milestones, URLs, or `gh` for this skill to work.

## Model Routing

For delegated opportunity review, option exploration, or slicing, resolve `delegate-design` from `.datum/config.json`. If that mapping is unavailable, inherit the session model and record the fallback in the artifact.
Apply the routing and escalation contract in `context/contracts/execution-contract.md`.

## Artifact

Create or update `<slug>--idea-to-backlog.md` with:

- source ideas, deduplication decisions, and an inventory of distinct ideas
- the thinnest meaningful slice, outcome, non-goals, and bundle justification for each buildable idea
- dependency map, opportunity briefs, options considered, and priority recommendation
- requirements and acceptance criteria with stable `R*` and `AC*` identifiers
- risk, rollout, rollback, observability, open-question, parked, and rejected-work records
- created work-item references and the selected provider/adapter capability gaps
- source revision assumptions: target ref/SHA when available, shaping time, and relevant scope references

## Shape

1. Normalize and deduplicate the inputs. Classify each as a feature, bug, research question, spike, prototype, chore, cleanup, or parked thought. Give every idea one outcome: discard, park, merge, research, shape, or commit.
2. Separate ideas before slicing. Name the user problem, stakeholder, risk, and success signal for each idea. Require a recorded split decision or bundle justification.
3. Review opportunity: product goal, affected user or operator, expected outcome, confidence, investment, tradeoffs, and what the work displaces.
4. Choose the path: shape work, time-boxed research, isolated prototype, or park/reject. A spike or prototype must state its learning question, artifact, cleanup expectation, and why it is not production implementation.
5. Shape the work with a problem statement, scope, non-goals, requirements, testable acceptance criteria, UX/API implications, verification expectations, risks, rollout and rollback notes, observability, and open questions.
6. Prioritize explicitly: do, defer, or reject; why now; expected outcome; confidence; size; risk; dependencies; alternatives; and decision owner.
7. File only committed or near-committed slices through `WorkItemProvider`. Preserve the readable brief and provider-neutral metadata needed for later selection: dependencies, blockers, source revisions, planning scope references, and the shaping artifact reference.

A thinnest meaningful slice is independently valuable and testable. Bundle only when the same outcome requires all included work, a hard dependency makes sequencing necessary, or grouping demonstrably reduces delivery risk.

## Work Item Contract

Each filed work item should include:

- story or operator outcome, problem, scope, and non-goals
- stable `R*` requirements and `AC*` acceptance criteria
- verification expectation and a future acceptance-evidence table: `AC id`, `Status`, `Command/Test Evidence`, `Source Evidence`, and `Gaps`
- priority rationale, expected size, dependencies/blockers, milestone or delivery outcome decision, and source artifact reference
- source revision groups with `planned_base_ref`, `planned_base_sha`, `planned_at`, and `planning_scope_refs` when the `RepositoryAdapter` can supply them

Use an adapter-neutral structured metadata attachment or field when supported. Native dependency, project, milestone, assignee, and custom-field features remain optional adapter enhancements.

## Active Builder Evidence

Only when an active `builder.shape` run is already bound to this work, inspect
its current state with the public workflow status command. Record each completed
expectation with the public workflow evidence command; use reviewable shaping
references and never an internal writer:

```bash
flow-agents workflow status --session-dir <session-dir>
flow-agents workflow evidence --session-dir <session-dir> \
  --expectation <expectation-id> --status pass \
  --summary "Shaped work and filed Work Item evidence are recorded." \
  --evidence-ref-json '{"kind":"artifact","file":"<session-dir>/<slug>--idea-to-backlog.md","summary":"Reviewable shaping report with slices and filed Work Item links."}'
```

At `shape`, record the six required shape expectations and `open-decisions` when applicable. At `breakdown`, record `slices-defined`. At `file-issues`, record `work-items-filed`. Use `fail` or `not_verified` when the artifact cannot support the expectation; never convert an accepted uncertainty into a passing claim.

## Stop

Stop when the selected path is shaped and either filed as executable work, intentionally parked, or explicitly rejected. Hand off to `pull-work` only when the user asks to select work for delivery.
