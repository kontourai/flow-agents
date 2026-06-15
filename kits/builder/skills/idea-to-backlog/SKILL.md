---
name: "idea-to-backlog"
description: "Turn raw product or technical ideas into shaped, prioritized, executable GitHub issue backlog. Use for idea intake, ideation, product shaping, spike/prototype decisions, PRD-like feature briefs, prioritization, and backlog creation before implementation starts."
---

# Idea To Backlog

Convert raw ideas into shaped, prioritized, executable backlog without starting production implementation.

## Contract

- Produce durable reasoning artifacts before creating execution issues.
- Own the human-readable backlog issue contract; downstream delivery workflows inherit and refine it rather than inventing a new shape.
- Create GitHub issues only for committed or near-committed work.
- Do not write production code or edit implementation files.
- Do not invoke downstream delivery skills while shaping upstream work.
- After the backlog gate, hand off to `pull-work` only if the user explicitly asks to continue.
- Never invoke `plan-work`, `execute-plan`, `review-work`, `verify-work`, `evidence-gate`, or release skills from this workflow.
- Stop at gates unless the user explicitly asks to continue.
- Treat GitHub issues as executable backlog, not the whole reasoning store.
- Keep separate ideas separate until a shared outcome, hard dependency, or sequencing reason justifies bundling them.
- Push back when the user blends unrelated ideas, and ask them to justify why the ideas belong together before shaping bundled work.

## Artifact Contract

Create or update `.flow-agents/<slug>/<slug>--idea-to-backlog.md` with:

- `source_ideas`: raw inputs and dedupe links
- `idea_inventory`: one record per distinct idea, classification, outcome, and reason
- `slice_candidates`: thinnest meaningful slice for each buildable idea, success signal, and non-goals
- `bundle_justification`: why grouped ideas belong together, or explicit decision to split
- `dependency_map`: blocks / blocked-by / related-only relationships between ideas or slices
- `phase`: intake, opportunity, explore, shape, prioritize, backlog, blocked, complete
- `decisions`: decision, rationale, decision maker, date
- `opportunity_briefs`: problem, stakeholder, outcome, confidence, size
- `shaped_work`: scope, non-goals, requirements, acceptance criteria
- `risk_release_notes`: risk class, rollout, rollback, observability
- `backlog_links`: GitHub issue URLs and status
- `parked_or_rejected`: reason and revisit trigger
- `open_questions`: owner and needed evidence
- `next_gate`: gate name and pass/fail/block status

## Workflow

### 1. Intake

Normalize and deduplicate raw ideas.

Classify each item as:

- feature
- bug
- research question
- spike
- prototype
- chore
- cleanup
- parked thought

Outcome: `discard`, `park`, `merge`, `research`, `shape`, or `commit`.

Gate: every idea has exactly one outcome and a recorded reason.

### 2. Separate Ideas And Slice

Create an idea inventory before shaping. Treat each distinct user problem, workflow, stakeholder, risk, or success metric as a separate idea unless proven otherwise.

When multiple ideas arrive together:

- name each idea separately
- identify the thinnest meaningful slice for each buildable idea
- challenge accidental bundles
- require a bundle justification before shaping grouped work
- distinguish hard dependencies from "related-only" context

A thinnest meaningful slice is the smallest independently valuable and testable unit that can reach evidence/release gates without leaving dependent half-work behind.

Bundled work is allowed only when at least one is true:

- one slice cannot deliver value without the other
- the same user outcome and acceptance signal require both
- the dependency order is explicit and the first slice unlocks the second
- grouping reduces delivery risk more than it increases scope risk

If the user is blending ideas without justification, push back directly and stop shaping the bundle until the relationship is clear.

Gate: every shaped candidate has one outcome, one thinnest meaningful slice, and either a split decision or a recorded bundle justification and dependency map.

### 3. Opportunity Review

For ideas worth shaping, capture:

- product/theme goal
- user or stakeholder
- problem / opportunity
- expected outcome
- confidence
- rough investment size
- tradeoffs and what this displaces

Gate: the opportunity is worth shaping, or it is parked/rejected.

### 4. Explore Options

Use `search-first` or `explore` when context is missing.

Decide the path:

- `shape-work`: enough is known to define the feature.
- `spike-research`: unknowns need investigation, no production code.
- `prototype-mvp`: visual or interaction proof is needed in an isolated worktree.
- `reject/park`: not worth current backlog.

For spikes and prototypes, define the learning question, timebox, artifact, and cleanup expectation. Prototype work must be isolated and must not silently become production implementation.

### 5. Shape Work

Create a brief with:

- story / user outcome: `As a <user/persona>, I want <capability>, so that <outcome>` when a user-facing story fits; otherwise use a concise system/operator outcome
- problem statement
- users / stakeholders
- scope
- non-goals
- requirements with stable ids, such as `R1`, `R2`
- UX/API implications
- acceptance criteria with stable ids, such as `AC1`, `AC2`; criteria must be testable and map back to requirements
- verification expectations that preserve AC ids and name expected command/test evidence plus source evidence/permalink expectations when implementation behavior is claimed
- risk class
- rollout / rollback notes
- observability or release concerns
- open questions

Gate: acceptance criteria are testable and scope/non-goals are stable enough for planning.

The backlog issue shape should optimize for human readability first, then workflow traceability:

- `Story / Outcome`
- `Problem`
- `Scope`
- `Non-goals`
- `Requirements` with stable `R*` ids
- `Acceptance Criteria` with stable `AC*` ids
- `Verification Expectation`
- `Acceptance Evidence` expectation: closure/provider comments must map AC ids to status, command/test evidence, source evidence/permalinks, and gaps
- `Milestone / Delivery Outcome`
- `Dependencies / Blockers`
- `Source Artifact`

Downstream `pull-work`, `plan-work`, `execute-plan`, `review-work`, `verify-work`, and `evidence-gate` must preserve the `R*` and `AC*` ids and add readiness, execution, modified-file scope, critique, and evidence mappings.

### 6. Prioritize

Produce a priority brief:

- recommendation: do / defer / reject
- why now
- expected outcome
- confidence
- cost / size
- risks
- dependencies
- alternatives
- human decision

Gate: tradeoff, priority, and decision maker are explicit.

### 7. Sync Executable Backlog

Use `github-cli` / `gh` for issues when available.

Create GitHub issues only for committed or near-committed execution units. Each issue should include:

- story / outcome
- problem
- scope
- non-goals
- requirements with stable `R*` ids
- acceptance criteria
- links to source brief / session artifact
- priority rationale
- milestone or milestone decision: assign a milestone when the work contributes to a named delivery outcome, or record why no milestone is appropriate
- expected size
- thinnest meaningful slice
- dependencies / blockers
- bundle justification if grouped with other issues
- verification expectation
- release/evidence expectation
- acceptance evidence expectation, including source evidence refs for behavior claims and immutable GitHub blob permalinks pinned to commit SHA when a provider change is available
- owner or assignee when known

Each synced issue body must preserve the human-readable `Dependencies / Blockers` prose for people and also include a provider-neutral structured metadata marker for adapters. The marker is workflow metadata embedded in the body, not a requirement to use provider-native dependency, sub-issue, project, or custom-field APIs. Native dependency surfaces are adapter-specific enhancements and are outside the generic skill contract.

At sync time, capture the source revision assumptions that shaped the issue:

- `planned_base_ref`: target branch or ref used during shaping
- `planned_base_sha`: exact commit SHA for that ref at shaping time
- `planned_at`: timestamp when the issue scope was shaped or last materially refreshed
- `planning_artifact_ref`: idea-to-backlog artifact, brief, design, ADR, or other source artifact that produced the issue
- `planning_scope_refs`: key docs, contracts, schemas, files, packages, or provider records considered while shaping

Represent source revision per relevant repository. Single-repo work may use one source revision group; cross-repo work should use an array of scoped groups so downstream consumers can compare each repository against its own planned base.

Emit structured `blockers[]` in the marker in addition to the prose `Dependencies / Blockers` section. Use structured entries for provider refs, artifact refs, decisions, external dependencies, and text blockers. Keep the prose section concise and readable; the structured marker carries normalized fields for `pull-work`, pickup Probe, and provider adapters.

Provider-neutral marker example:

```markdown
<!-- flow-agents:work-item-metadata
{
  "schema_version": "1.0",
  "source_revisions": [
    {
      "repo": "owner/repo",
      "planned_base_ref": "main",
      "planned_base_sha": "0123456789abcdef0123456789abcdef01234567",
      "planned_at": "2026-06-03T03:23:14Z",
      "planning_artifact_ref": ".flow-agents/example/example--idea-to-backlog.md",
      "planning_scope_refs": [
        "kits/builder/skills/idea-to-backlog/SKILL.md",
        "context/contracts/work-item-contract.md"
      ]
    }
  ],
  "blockers": [
    {
      "type": "work_item",
      "ref": "provider://work-items/123",
      "status": "blocked",
      "summary": "Needs the upstream contract issue to land first."
    },
    {
      "type": "text",
      "status": "blocked",
      "summary": "Needs product decision on rollout scope."
    }
  ]
}
-->
```

For one-repo issues, adapters may normalize the first source revision group to top-level `planned_base_ref`, `planned_base_sha`, `planned_at`, `planning_artifact_ref`, and `planning_scope_refs` while preserving `source_revisions` when present.

Avoid creating tiny implementation tasks too early; `plan-work` can decompose inside an execution artifact later.

Gate: every created issue is ready for `pull-work` or explicitly marked blocked/needs shaping.

Backlog issue bodies should not require live provider calls to create permalinks during shaping. They should require downstream closure comments to include an `Acceptance Evidence` table with columns `AC id`, `Status`, `Command/Test Evidence`, `Source Evidence / Permalinks`, and `Gaps`; source evidence can start as local file/line refs during verification and should be upgraded to immutable provider permalinks before closure when available.

When a GitHub Project is used, decide whether milestones are represented as repo milestones, project fields, issue labels, or intentionally omitted. Record the chosen milestone strategy in the artifact and apply it consistently to created issues/project items when the provider supports it.

## Gates

- Idea Gate: deduped, classified, and either discarded, parked, merged, researched, shaped, or committed.
- Slice Gate: every candidate has one outcome, one thinnest meaningful slice, and explicit split/bundle/dependency reasoning.
- Shape Gate: brief is coherent and acceptance criteria are stable enough.
- Priority Gate: priority and tradeoff are explicit.
- Backlog Gate: GitHub issues are ready for `pull-work`.

If a gate fails, update the artifact with the missing evidence or decision and stop.

## Backlog Hygiene

- Do not let every qualified idea become an issue.
- Use an inbox, opportunity store, shaped queue, executable backlog, and archive.
- Parked ideas need a reason and revisit trigger.
- Stale issues should be closed, archived, or returned to discovery.
