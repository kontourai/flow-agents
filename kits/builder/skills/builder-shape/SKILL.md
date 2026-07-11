---
name: "builder-shape"
description: "Builder Kit shaping entrypoint. Turns a raw idea into a provider-neutral, reviewable backlog proposal and stops before build selection unless the user explicitly continues."
---

# Builder Shape

## Role and Boundary

**Role:** Builder Kit entrypoint for `builder.shape`.

Use this surface only when the user explicitly asks to shape an idea with Builder
Kit, or accepts it after it is offered as an option. It delegates shaping to
`idea-to-backlog`; it does not implement, select, or deliver work.

`builder.shape` is selected for raw ideas, vague outcomes, PRD-like concepts,
spikes, and prototypes. It is not a generic routing rule for every planning
request. Direct `idea-to-backlog` remains a valid standalone primitive.

This entrypoint owns **no step-gate evidence**. `idea-to-backlog` owns its
shaping artifact and any evidence required by its own contract.

## Model Routing

Resolve `delegate-design` from `.datum/config.json` for shaping and alignment.
Model choice and reasoning effort follow
`context/contracts/execution-contract.md`; if the mapping is unavailable,
inherit the session model and record the fallback.

## Inputs and Providers

Start from the user's raw idea, notes, or current conversation context. Ask
one focused alignment question at a time when outcome, constraints, non-goals,
success signal, risk, or the relationship between ideas is unclear.

Describe backlog targets through adapters:

- **Work Item adapter:** the proposed buildable unit and its acceptance context.
- **Board adapter:** the destination queue or backlog, when one is requested.
- **Repository adapter:** the repository or product boundary affected by the item.

No adapter is required merely to shape an idea. A GitHub issue or project may
be a labeled example of a Work Item or Board adapter, never a required
contract.

## Flow Behavior

1. Derive a safe explicit slug from the selected shape title: lowercase ASCII
   words separated by single hyphens. Never interpolate raw request text into a
   shell command, slug, or quoted argument.
2. Start and inspect the public shape run using the safe slug and a fixed,
   operator-authored summary:

```bash
flow-agents workflow start --flow builder.shape \
  --task-slug <safe-shape-slug> \
  --summary "Shape the selected work into independently actionable slices."
flow-agents workflow status --session-dir .kontourai/flow-agents/<safe-shape-slug> --json
```

3. State that this entrypoint selects `builder.shape` and delegates to
   `idea-to-backlog`.
4. Gather and clarify the idea.
5. Have `idea-to-backlog` produce its normal shaping result, including
   candidate Work Items, slicing, risks, decisions, and a next-action.
6. Stop at the backlog decision. Create or synchronize provider records only
   when the user explicitly requests it and the relevant adapters are known.

Do not duplicate `idea-to-backlog`'s intake, prioritization, slicing, artifact,
or gate logic. Do not invoke `pull-work`, `plan-work`, `execute-plan`,
`review-work`, `verify-work`, or release activities from this entrypoint.

## Output Responsibility

The produced result is the standard `idea-to-backlog` shaping report. It must
identify the selected flow (`builder.shape`), the source ideas, candidate Work
Items, provider-sync status, decisions, open questions, and the backlog
decision. This entrypoint creates no step evidence; `idea-to-backlog` records
the owning trust-bundle slices through the public CLI.

## Standalone and No-Active-Run Behavior

`builder.shape` may run independently of `builder.build`. If a prior shaping
report exists, use it as context; do not assume it authorizes provider
synchronization or build execution. If the public shape interface is unavailable,
report an unsupported-runtime blocker rather than using an internal writer.
