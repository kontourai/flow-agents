---
name: "builder-shape"
description: "Invoke Builder Kit shape from a raw idea or the current conversation context without requiring the user to name idea-to-backlog. Delegates shaping to idea-to-backlog, records the Builder Kit Flow Definition link, and stops at the backlog gate unless GitHub issue sync is explicitly requested."
---

# Builder Shape

Invoke the Builder Kit `shape` flow for raw product ideas, vague build goals, current conversation context, PRD-like concepts, spikes, prototypes, or work that needs alignment before implementation.

## Contract

- Product surface: let the user ask for "Builder Kit shape", "builder shape", or "shape this with Builder Kit" without naming `idea-to-backlog`.
- Proactive suggestion: when a user starts planning a feature, product, PRD, roadmap item, or vague build idea without naming a workflow, briefly suggest Builder Kit shape as the structured path before implementation. Phrase it as an option, not a forced gate, unless the request is too ambiguous to plan responsibly.
- Delegation: use `kits/builder/skills/idea-to-backlog/SKILL.md` as the shaping primitive. Do not duplicate or replace its workflow, artifact contract, issue shape, or gate rules.
- Product-level auto-guidance: when the user invokes Builder Kit shape, guide them through `design-probe` alignment and then the `idea-to-backlog` workflow directly; do not require them to type `design-probe` or `idea-to-backlog` as additional skill names.
- do not require them to type `idea-to-backlog`; Builder Kit shape owns the user-facing route into that primitive.
- Flow reference: link every Builder Kit shape artifact to the Builder Kit Flow Definition at `kits/builder/flows/shape.flow.json`.
- Input: start from the user's raw idea, pasted notes, or the current conversation context.
- Probe/alignment: when the idea, user outcome, constraints, non-goals, success signal, risk, or bundle relationship is unclear, run `design-probe` style alignment before continuing.
- Default stop: stop at the backlog gate by default. Do not create GitHub issues, sync to a project, or hand off to `pull-work` unless the user explicitly asks for that next step.
- Boundary: do not run Builder Kit build execution, remote kit install, package extraction, downstream delivery workflows, `plan-work`, `execute-plan`, `review-work`, `verify-work`, `evidence-gate`, or release workflows from this invocation.
- Compatibility: Direct `idea-to-backlog` usage remains valid and should behave exactly as described in `kits/builder/skills/idea-to-backlog/SKILL.md`.
- Primitive recovery: if a user invokes `idea-to-backlog` or another primitive with missing shaping context and appears to want the product flow, explain that Builder Kit shape is the entry point and offer to route there.

## Invocation

Use this skill when the user says things like:

- `Use Builder Kit shape for this idea: ...`
- `Builder shape the current conversation into backlog candidates.`
- `Shape this with Builder Kit, but do not create issues yet.`
- `Run Builder Kit shape and sync GitHub issues only after I confirm.`

When activated:

1. Read `kits/builder/skills/idea-to-backlog/SKILL.md`.
2. State that Builder Kit shape delegates to `idea-to-backlog` and uses `kits/builder/flows/shape.flow.json`.
3. Gather the raw idea or current conversation context.
4. If needed, use `design-probe`: ask one Probe/alignment question at a time before shaping. Prefer questions that clarify user outcome, constraints, non-goals, success criteria, risk, or whether bundled ideas truly belong together.
5. Create or update the standard `.kontourai/flow-agents/<slug>/<slug>--idea-to-backlog.md` artifact using the `idea-to-backlog` artifact contract.
6. Add a `builder_kit_shape` or equivalent note in the artifact that links to `kits/builder/flows/shape.flow.json` and records that the product-level Builder Kit shape surface was used.
7. Stop at `next_gate: Backlog Gate` unless the user explicitly requested GitHub issue sync.
8. If the user asked for guided Builder Kit continuation, record the expected next step as `pull-work` after issue sync or backlog approval; otherwise record manual mode and stop.

## Artifact Requirements

The artifact must keep the standard `idea-to-backlog` sections:

- `source_ideas`
- `idea_inventory`
- `slice_candidates`
- `bundle_justification`
- `dependency_map`
- `phase`
- `decisions`
- `opportunity_briefs`
- `shaped_work`
- `risk_release_notes`
- `backlog_links`
- `parked_or_rejected`
- `open_questions`
- `next_gate`

For Builder Kit shape invocations, also include:

- Builder Kit Flow Definition: `kits/builder/flows/shape.flow.json`
- Explicit issue-sync status, such as `not_requested`, `requested`, or `completed`
- A backlog-gate decision that says whether the workflow stopped before issue creation

## GitHub Issue Sync

Issue sync is explicit-only.

- If the user did not ask to create or sync issues, set `backlog_links` to `not_requested` or an empty recorded status and stop at the backlog gate.
- If the user asks to create or sync issues, follow the GitHub issue rules in `kits/builder/skills/idea-to-backlog/SKILL.md`.
- If provider details are missing, ask for them instead of assuming a GitHub repository, project, labels, milestone, or assignee.
