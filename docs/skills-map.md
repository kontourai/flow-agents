---
title: Flow Agents Skills Map
---

# Flow Agents Skills Map

This map groups the current skills by the user journey they support. The Builder Kit workflow system is centered on concrete workflow skills, while Flow Agents coordinates Flow Kit installation, runtime adapters, and local control.

For practical operator instructions and copy/paste prompts, see https://github.com/kontourai/flow-agents/blob/main/docs/workflow-usage-guide.md. For the shared cross-distribution contracts behind the workflow artifacts and gates, see https://github.com/kontourai/flow-agents/blob/main/docs/workflow-shared-contracts.md.

- `builder-shape`: product-level Builder Kit shape invocation that guides `idea-to-backlog` without requiring the user to name the primitive, links `kits/builder/flows/shape.flow.json`, and stops at the backlog gate unless issue sync is explicit.
- `idea-to-backlog`: discovery, idea separation, thinnest meaningful slice, shaping, prioritization, and executable GitHub issue creation.
- `pull-work`: dynamic backlog selection, grouping/dependency checks, WIP awareness, worktree decision, and execution handoff; in Builder Kit build, every selected item or justified group needs fresh pickup Probe evidence before planning.
- `design-probe`: generic one-question-at-a-time probing interview; Builder Kit uses this step before planning when the build flow needs shared understanding or a pickup decision.
- `pickup-probe`: Builder Kit specialization of `design-probe` for selected work items; records scope, provider state, WIP/conflict scans, risks, decisions, unresolved questions, accepted gaps, and planning readiness.
- `plan-work` / `execute-plan` / `deliver`: Definition Of Done, execution orchestration, and local delivery closure.
- `review-work`: report-only critique for quality, security triggers, architecture fit, and standards findings.
- `verify-work`: behavior evidence mapped to acceptance criteria and Goal Fit.
- `evidence-gate`: trust assessment for completed work: acceptance evidence, integrity checks, CI confidence, and next step.
- `release-readiness`: operational decisioning for a published change: merge/release/deploy/hold, rollback, observability, final acceptance docs, and post-deploy planning.
- `learning-review`: post-merge/post-deploy learning, follow-up routing, docs promotion checks, and durable knowledge capture.

```mermaid
flowchart LR
  Idea[Raw idea or goal]
  Shape[Builder Kit shape / idea-to-backlog<br/>shape executable work]
  Pickup[pull-work<br/>select ready work]
  Probe[design-probe / pickup-probe<br/>pickup Probe before planning]
  Build[plan-work + execute-plan<br/>build the slice]
  Review[review-work<br/>critique code and risk]
  Verify[verify-work<br/>prove behavior]
  GoalFit[goal-fit<br/>check user outcome]
  Trust[evidence-gate<br/>map criteria to evidence]
  Publish[publish-change<br/>commit / push / PR / CI]
  Release[release-readiness<br/>merge / release / deploy / docs decision]
  Learn[learning-review<br/>route follow-ups]
  Backlog[(GitHub issues)]

  Idea --> Shape --> Backlog --> Pickup --> Probe --> Build --> Review --> Verify --> GoalFit --> Trust --> Publish --> Release --> Learn
  Probe -->|not needed| Build
  Pickup -->|too vague or stale| Shape
  Review -->|findings| Build
  GoalFit -->|incomplete| Build
  Trust -->|FAIL / NOT_VERIFIED| Build
  Learn -->|new work| Shape
```

## Current Shape

The operating model now has first-class coverage from idea intake through trusted delivery:

- Upstream product work is exposed through `builder-shape` and owned by `idea-to-backlog`.
- Backlog selection and execution handoff are owned by `pull-work`.
- Design probing is a generic skill named `design-probe`; in the Builder Kit build flow the step is still named `design-probe`, and the `pickup-probe` specialization records selected-work readiness before planning. `decision_gap` route-backs return there for missing pickup/planning decisions.
- Product-level Builder Kit build may guide `pull-work -> design-probe / pickup-probe -> plan-work`; direct primitives still stop at their own gates and report the expected next step.
- Broad continuation language does not carry across newly selected work after merge. Queue inspection is allowed, but planning the next item requires a fresh pickup Probe record.
- Critique is owned by `review-work` and persisted in `critique.json`.
- Verification is owned by `verify-work` and persisted in `evidence.json`.
- Trust evidence is assessed by `evidence-gate`; it decides whether completed work has enough proof and integrity to publish or continue fixing.
- Publishing verified changes is the bridge between evidence and release readiness: commit the verified diff, push the branch, open or update the PR, and collect PR/CI evidence.
- Merge/release/deploy decisioning is owned by `release-readiness` after the publish-change gate.
- Retrospective learning and follow-up routing are owned by `learning-review`.
- Implementation still flows through `plan-work`, `execute-plan`, `review-work`, and `verify-work`, with `Definition Of Done` and `Goal Fit Gate` preventing task-complete-but-user-incomplete delivery.
- Real browser/runtime checks remain delegated to `feedback-loop` and `browser-test`.

The upstream guardrail is intentionally strict: multiple ideas are inventoried separately first, the thinnest meaningful slice is identified for each buildable idea, and bundled work must have an explicit dependency or shared-outcome justification. The pickup workflow repeats this check before planning so unrelated backlog items do not silently become one implementation stream.

The intentionally deferred primitives such as `intake-idea`, `shape-work`, `test-map`, and `scope-and-integrity-check` are nested workflow sections for now. They should become separate skills only if their behavior grows enough to need independent contracts, artifacts, or eval suites.

## Phase Composition

This view shows how each phase is composed. The left rail is the durable phase sequence; each phase row names its primary owner, supporting skills, nested sections that may later become primitives, and the gate/artifact that lets the next phase begin.

<section class="phase-map" aria-label="Workflow phase composition">
  <article class="phase-row">
    <div class="phase-step"><span>01</span><strong>Discovery & shaping</strong></div>
    <div class="phase-lanes">
      <section class="phase-lane phase-lane--primary"><h3>Primary</h3><p><code>builder-shape</code> <code>idea-to-backlog</code></p></section>
      <section class="phase-lane"><h3>Support</h3><p><code>knowledge-search</code> <code>search-first</code> <code>explore</code> <code>crowdsource</code> <code>frontend-design</code> <code>github-cli</code> <code>knowledge-capture</code></p></section>
      <section class="phase-lane"><h3>Nested sections / future primitives</h3><p>intake/dedupe, separate ideas, thinnest meaningful slice, opportunity review, explore options, <code>shape-work</code>, prioritize work, sync executable backlog</p></section>
      <section class="phase-lane phase-lane--gate"><h3>Gate & artifact</h3><p>Idea, slice, shape, and backlog gates. Writes shaped briefs and GitHub issue links in <code>.flow-agents/&lt;slug&gt;/</code>.</p></section>
    </div>
  </article>
  <article class="phase-row">
    <div class="phase-step"><span>02</span><strong>Backlog pickup</strong></div>
    <div class="phase-lanes">
      <section class="phase-lane phase-lane--primary"><h3>Primary</h3><p><code>pull-work</code></p></section>
      <section class="phase-lane"><h3>Support</h3><p><code>github-cli</code></p></section>
      <section class="phase-lane"><h3>Nested sections / future primitives</h3><p>board snapshot, WIP check, grouping/dependency check, pickup Probe decision, worktree decision, <code>plan-work</code> handoff</p></section>
      <section class="phase-lane phase-lane--gate"><h3>Gate & artifact</h3><p>Pickup gate and pickup Probe handoff. Writes selected issues, blockers, bundle justification, provider state, accepted gaps, worktree policy, expected modified files, conflict risks, and handoff notes.</p></section>
    </div>
  </article>
  <article class="phase-row">
    <div class="phase-step"><span>03</span><strong>Planning & build</strong></div>
    <div class="phase-lanes">
      <section class="phase-lane phase-lane--primary"><h3>Primary</h3><p><code>plan-work</code> <code>execute-plan</code> <code>review-work</code> <code>verify-work</code></p></section>
      <section class="phase-lane"><h3>Support</h3><p><code>feedback-loop</code> <code>browser-test</code> <code>deliver</code> <code>fix-bug</code> <code>tdd-workflow</code></p></section>
      <section class="phase-lane"><h3>Nested sections / future primitives</h3><p>Definition Of Done, execution plan, parallel waves, implementation session state, critique report, verification report, runtime/browser validation, Goal Fit Gate</p></section>
      <section class="phase-lane phase-lane--gate"><h3>Gate & artifact</h3><p>Review, verification, and Goal Fit gates. Produces critique findings plus test, build, lint, browser, or runtime evidence tied to acceptance criteria and the user-facing outcome.</p></section>
    </div>
  </article>
  <article class="phase-row">
    <div class="phase-step"><span>04</span><strong>Evidence & release</strong></div>
    <div class="phase-lanes">
      <section class="phase-lane phase-lane--primary"><h3>Primary</h3><p><code>evidence-gate</code> <code>release-readiness</code></p></section>
      <section class="phase-lane"><h3>Support</h3><p><code>github-cli</code> <code>eval-rebuild</code></p></section>
      <section class="phase-lane"><h3>Nested sections / future primitives</h3><p>criteria-to-evidence map, CI confidence, <code>scope-and-integrity-check</code>, publish-change, rollback review, observability review, post-deploy plan, final acceptance docs, remediate-ci</p></section>
      <section class="phase-lane phase-lane--gate"><h3>Gate & artifact</h3><p>Evidence, publish-change, release, and docs gates. Writes confidence, integrity, commit/branch/PR/CI links, release scope, risk, rollback, deploy-readiness decisions, and durable documentation links.</p></section>
    </div>
  </article>
  <article class="phase-row">
    <div class="phase-step"><span>05</span><strong>Learning & improvement</strong></div>
    <div class="phase-lanes">
      <section class="phase-lane phase-lane--primary"><h3>Primary</h3><p><code>learning-review</code></p></section>
      <section class="phase-lane"><h3>Support</h3><p><code>knowledge-capture</code> <code>observe</code> <code>idea-to-backlog</code> <code>eval-rebuild</code></p></section>
      <section class="phase-lane"><h3>Nested sections / future primitives</h3><p>facts vs interpretation, follow-up routing, docs promotion review, knowledge updates, eval updates, skill/backlog improvements</p></section>
      <section class="phase-lane phase-lane--gate"><h3>Gate & artifact</h3><p>Learning gate. Writes outcomes, gaps, docs promotion state, follow-ups, knowledge updates, and verdict.</p></section>
    </div>
  </article>
</section>

| Phase | Primary workflow skill | Supporting skills | Nested sections / future primitive candidates |
| --- | --- | --- | --- |
| Idea discovery and shaping | `builder-shape`, `idea-to-backlog` | `knowledge-search`, `search-first`, `explore`, `crowdsource`, `frontend-design`, `github-cli`, `knowledge-capture` | intake/dedupe, separate ideas, thinnest meaningful slice, opportunity review, explore options, shape work, prioritize work, sync executable backlog |
| Backlog pickup | `pull-work` | `github-cli` | board snapshot, WIP check, grouping/dependency check, Probe decision, worktree decision, handoff |
| Execution planning and build | `design-probe`, `pickup-probe`, `plan-work`, `execute-plan`, `review-work`, `verify-work` | `feedback-loop`, `browser-test`, `deliver`, `fix-bug`, `tdd-workflow` | Probe notes, Builder Kit Probe record, Definition Of Done, execution plan, parallel waves, implementation session state, critique report, verification report, Goal Fit Gate |
| Evidence and release confidence | `evidence-gate`, `release-readiness` | `github-cli`, `eval-rebuild` | criteria-to-evidence map, CI confidence, scope/integrity check, publish-change, rollback review, observability review, final acceptance docs, post-deploy plan |
| Learning and improvement | `learning-review` | `knowledge-capture`, `observe`, `idea-to-backlog`, `eval-rebuild` | facts vs interpretation, docs promotion review, follow-up routing, knowledge updates, eval/skill/backlog improvements |

The highest-leverage future extractions are likely `shape-work`, `test-map`, `scope-and-integrity-check`, and `remediate-ci`. They are still nested because their behavior is present, but not yet large enough to need separate activation contracts.

## Gates And Artifacts

Each workflow phase ends with an explicit gate and durable artifact:

- `builder-shape` invokes Builder Kit shape, delegates to `idea-to-backlog`, links `kits/builder/flows/shape.flow.json`, and writes the standard `.flow-agents/<slug>/<slug>--idea-to-backlog.md` artifact.
- `idea-to-backlog` writes `.flow-agents/<slug>/<slug>--idea-to-backlog.md` and produces shaped briefs plus GitHub issue links.
- `pull-work` writes `.flow-agents/<slug>/<slug>--pull-work.md` with selected issues, WIP notes, blockers, pickup Probe decisions or accepted gaps, worktree decision, expected modified files, conflict risks, and a `plan-work` handoff.
- `plan-work` and `deliver` write `.flow-agents/<slug>/<slug>--*.md` artifacts with `Definition Of Done`, `Goal Fit Gate`, and `Final Acceptance` sections.
- `review-work` writes reviewer artifacts when available and updates `critique.json` with quality, security, architecture, standards, and resolution state.
- `verify-work` writes verification artifacts and updates `evidence.json` with behavior evidence mapped to acceptance criteria.
- `evidence-gate` writes `.flow-agents/<slug>/<slug>--evidence-gate.md` with acceptance evidence, CI summary, integrity report, verdict, and next step.
- `release-readiness` writes `.flow-agents/<slug>/<slug>--release-readiness.md` with release scope, evidence reference, risk review, operational plan, rollback plan, observability plan, post-deploy checks, and decision.
- `learning-review` writes `.flow-agents/<slug>/<slug>--learning-review.md` with outcomes, evidence, decisions, gaps, follow-ups, knowledge updates, and verdict.

Core gates:

- Idea Gate: raw input is deduped, classified, and routed.
- Slice Gate: each candidate has one outcome, one thinnest meaningful slice, and explicit split/bundle/dependency reasoning.
- Shape Gate: scope, non-goals, risk, rollout notes, and acceptance criteria are stable enough.
- Backlog Gate: GitHub issues represent executable or near-executable work.
- Pickup Gate: selected work is ready, WIP is acceptable, and worktree policy is recorded.
- Review Gate: report-only reviewers have no open blocking findings, or findings are explicitly accepted/deferred/false positive.
- Verification Gate: implementation evidence exists from local, automated, browser, or runtime checks.
- Goal Fit Gate: the original user outcome is satisfied, gaps are explicit, and local/project/global scope is clear.
- Evidence Gate: acceptance criteria are mapped to falsifiable evidence and scope integrity is checked.
- Publish Change Gate: verified changes are committed, pushed, represented by a PR or explicit no-PR decision, and PR checks/CI are linked.
- Release Gate: CI, docs, rollout, rollback, observability, and owner concerns are addressed for the risk class.
- Docs Gate: accepted planning artifacts are archived and promoted into durable docs when useful.
- Learning Gate: failures and recurring patterns are routed to tests, evals, skills, backlog, or knowledge capture.

## End-To-End Flow

```mermaid
flowchart LR
  Idea[Idea / vague goal]
  BacklogSkill[idea-to-backlog]
  Issue[Executable GitHub issue]
  Pull[pull-work]
  Probe[design-probe]
  Worktree[worktree decision]
  Plan[plan-work]
  Execute[execute-plan]
  Review[review-work]
  Verify[verify-work]
  GoalFit[goal-fit]
  Evidence[evidence-gate]
  Publish[publish-change]
  Release[release-readiness]
  Docs[final acceptance docs]
  Learning[learning-review]
  Done[merged / shipped]

  Idea --> BacklogSkill --> Issue --> Pull --> Probe --> Worktree --> Plan --> Execute --> Review --> Verify --> GoalFit --> Evidence
  Evidence -->|PASS| Publish --> Release --> Done --> Docs --> Learning
  Review -->|findings| Execute
  GoalFit -->|incomplete| Plan
  Evidence -->|FAIL / NOT_VERIFIED| Plan
  Pull -->|too vague / stale| BacklogSkill
  Learning -->|systemic change| Eval[eval-rebuild / backlog / skill update]
```

## Eval Coverage

Workflow evals are layered to match this map:

- Static contract evals guard non-negotiable skill boundaries.
- Behavioral activation evals check that agents choose the right workflow and stop at gates.
- Artifact quality evals inspect durable session artifacts and GitHub issue drafts.
- Adversarial evals exercise premature coding, vague issues, missing CI, weakened tests, and prototype promotion risks.
- End-to-end evals cover `idea-to-backlog -> pull-work -> design-probe -> plan-work -> execute-plan -> review-work -> verify-work -> goal-fit -> evidence-gate` selectively.

This keeps one conversation capable of carrying the full operating loop while making each phase produce an artifact that the next phase can verify.
