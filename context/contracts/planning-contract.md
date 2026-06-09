# Planning Contract

Planning turns a user goal into an executable implementation plan without writing production code.

## Required Inputs

- original user goal
- working directory
- relevant constraints from conversation, AGENTS.md, and active skills
- session artifact path when part of a larger workflow
- research findings when the work depends on unfamiliar external APIs, libraries, or current behavior

## Required Output

Produce a plan artifact that follows `context/contracts/artifact-contract.md`.

Also create or update structured sidecars beside the Markdown artifacts:

- `state.json`: phase `planning`, then `planned` status once the plan is ready.
- `acceptance.json`: each acceptance criterion from the Definition Of Done, with `pending` status and expected evidence references when known.
- `handoff.json`: summary and next steps when the plan is ready for execution or user approval.

Use the sidecar writer when available:

```bash
npm run workflow:sidecar -- init-plan .flow-agents/<slug>/<slug>--deliver.md \
  --source-request "<original request>" \
  --summary "<planning summary>" \
  --next-action "<next execution step>"
```

The plan body must include:

```markdown
## Plan

<one-paragraph approach and key decisions>

## Definition Of Done

- **User outcome:** <what the user can understand, run, decide, or operate after delivery>
- **Scope:** <included work and explicitly excluded work>
- **Acceptance criteria:**
  - [ ] AC1 `<stable-id>`: <criterion> - Evidence: <test, command, screenshot, dashboard, doc, CI, or manual check>; Source evidence: <expected file/line refs or provider permalink expectation when implementation behavior is claimed>
- **Usefulness checks:**
  - [ ] User-facing workflow is documented or discoverable
  - [ ] Local and global/project scope are separated when relevant
  - [ ] Dashboard/UI changes have visual evidence when relevant
  - [ ] Unknown, NOT_VERIFIED, and TODO gaps are resolved or explicitly accepted
- **Stop-short risks:** <ways this could technically pass while still not meeting the user's goal>
- **Durable docs target:** <docs path to update after CI/merge, or "not needed" with reason>
- **Sandbox mode:** <one of `local-read-only`, `local-edit`, `worktree`, `container`, `cloud-sandbox`, or `privileged-integration`; see `context/contracts/sandbox-policy.md`>

## Baseline and AC revalidation

- **Current target:** <latest target ref/SHA used for planning, or `not applicable` for direct local planning>
- **Freshness source:** <pull-work or pickup Probe artifact ref, `revision_freshness`, and planned base ref/SHA when present>
- **Accepted gap baseline:** <explicit accepted gap such as missing historical `planned_base_sha` with fallback baseline, or `none`; missing `planned_base_sha` is not fresh>
- **AC revalidation against drift:** <each upstream AC id revalidated against current target, changed scope intersections, dependency/provider state, and provider history>
- **Stale assumptions:** <assumptions invalidated by target movement, changed files, contracts, dependencies, provider state, or `none`>
- **Route-back decision:** <`none`, route back to pickup Probe for unresolved pickup/planning gaps, or route stale shaped work back to idea-to-backlog>

### Wave 1 (parallel)

#### Task: <name>
- **Files:** <create/modify/delete list>
- **Changes:** <specific behavior changes>
- **Acceptance:** <criterion-level evidence expected>
- **Supports:** <AC ids and requirement ids supported by this task>
- **Context:** <patterns, constraints, or references>
```

## Planning Rules

- Explore enough codebase context to make the plan executable.
- Reuse existing patterns before inventing new ones.
- Separate independent tasks into parallel waves and dependent tasks into later waves.
- Every task must have concrete acceptance criteria.
- Preserve stable requirement and acceptance ids from upstream backlog issues when they exist; otherwise create stable ids in the plan before execution.
- Every implementation task must map back to the acceptance criteria it supports.
- Acceptance criteria for implementation behavior must name expected command/test evidence and expected source evidence. Source evidence means structured refs with `kind`, `url`, `file`, `line_start`, `line_end`, and `excerpt` where applicable; use immutable GitHub blob permalinks pinned to a commit SHA when provider URLs are available, and local file/line refs only as pre-publish fallback.
- Plans should state that provider, PR, issue, closure, and final acceptance comments need an `Acceptance Evidence` table with columns `AC id`, `Status`, `Command/Test Evidence`, `Source Evidence / Permalinks`, and `Gaps`.
- The Definition Of Done is the stop condition, not a decorative section.
- If the goal is exploratory or uncertain, define what the user should be able to take away from the work.
- Call out stop-short risks during planning, especially when a technical implementation could pass while the user still cannot run, inspect, understand, or act on the result.
