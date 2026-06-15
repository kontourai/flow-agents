---
title: Workflow Usage Guide
---

# Workflow Usage Guide

This guide shows how to use the Builder Kit workflow skills in normal chats.

> **Which doc do I want?** This page is the *driver's manual* — what to say at each stage and what should happen. If you want the conceptual map first — layers, sidecars, hooks, evidence, and why the system is shaped this way — read the [Agent System Guidebook](agent-system-guidebook.md). For a one-line summary of every skill and gate, use the [Skills Map](skills-map.md). Flow Agents coordinates the local runtime, installs Flow Kits, and records artifacts; Flow owns gate semantics, including typed `expects` entries with `kind: "surface.claim"`, trusted producer config, and gate overrides.

The core pattern is:

```text
ideas -> Builder Kit shape / idea-to-backlog -> work items -> pull-work -> pickup Probe / design-probe -> plan-work -> execute-plan -> review-work -> verify-work -> goal-fit -> evidence-gate -> publish-change -> release-readiness -> final-acceptance-docs -> learning-review
```

You can do this in one conversation, but the gates should stay explicit. Do not let shaping, planning, implementation, and release confidence blur into one continuous task.

Workflow artifacts follow a closeout lifecycle. Local runtime artifacts live under `.flow-agents/<slug>/` and stay uncommitted. When a branch needs reviewable in-progress planning, promote durable behavior, decisions, evidence, and usage notes into long-lived docs, source, schemas, or provider records before merge.

For local artifact queue hygiene, run the read-only cleanup audit:

```bash
npm run workflow-artifact-cleanup-audit -- --artifact-root .flow-agents
```

The audit is linked to the lifecycle policy in `docs/workflow-artifact-lifecycle.md`. It classifies active WIP, cleanup candidates, terminal done records, active learning follow-ups, and invalid sidecars without deleting or archiving anything.

## 1. Shape Ideas Before Building

Use Builder Kit shape when you have raw ideas, feature concepts, product thoughts, prototype ideas, current conversation context, or a vague goal. This is the product-level Builder Kit invocation for shaping work; internally it delegates to `idea-to-backlog`, which remains available for direct use.

Example prompt:

```text
Use Builder Kit shape. I have several ideas:
- onboarding checklist
- billing alert improvements
- AI dashboard summary

Separate these into distinct ideas, use Probe/alignment questions if the outcome or bundle is unclear, find the thinnest meaningful slice for each, push back if I bundle unrelated work, and stop at the backlog gate unless I explicitly ask you to sync GitHub issues.
```

Expected behavior:

- delegate shaping to `kits/builder/skills/idea-to-backlog/SKILL.md`
- link the artifact to the Builder Kit Flow Definition at `kits/builder/flows/shape.flow.json`
- inventory each distinct idea separately
- classify each idea
- identify the thinnest meaningful slice
- shape executable work items with a readable story/outcome, scope, non-goals, stable `R*` requirement ids, stable `AC*` acceptance ids, verification expectation, milestone/delivery outcome, dependencies, and source artifact
- require bundle justification before grouping ideas
- map dependencies as blocking, blocked-by, or related-only
- stop at the backlog gate unless you explicitly ask to continue or explicitly request GitHub issue sync

Expected artifact:

```text
.flow-agents/<slug>/<slug>--idea-to-backlog.md
```

The artifact should include `source_ideas`, `idea_inventory`, `slice_candidates`, `bundle_justification`, `dependency_map`, `phase`, `decisions`, `opportunity_briefs`, `shaped_work`, `risk_release_notes`, `backlog_links`, `parked_or_rejected`, `open_questions`, `next_gate`, and the Builder Kit Flow Definition link. Use this phase to decide what deserves backlog space. Provider-backed work items should be executable or near-executable work, not a dumping ground for every idea. GitHub issues are the first adapter example.

Direct `idea-to-backlog` prompts still work. Use them when you want to name the underlying shaping primitive directly:

```text
Use idea-to-backlog. Shape this raw idea into an executable backlog artifact and stop before implementation.
```

Builder Kit shape is the product-level entry point. If you ask for Builder Kit shape, the agent should guide the `idea-to-backlog` workflow without making you type the primitive name. If you ask for direct `idea-to-backlog`, the primitive should run directly, stop at its gate, and report the expected next step instead of silently entering Builder Kit build.

## 2. Push Back On Blended Ideas

The system should challenge you when ideas bleed together.

Good bundle justification:

```text
These belong together because saved filters are required before saved views can exist, and saved views are the acceptance signal for the first release.
```

Weak bundle justification:

```text
They are all dashboard improvements.
```

If the relationship is only thematic, split the work. If there is a real dependency, record the dependency and plan the first unlockable slice.

## 3. Pull Ready Work From The Backlog

Use `pull-work` when provider-backed work items already exist and you want to choose what to work on next. GitHub issues are the first concrete adapter example, not the core workflow vocabulary.

Example prompt:

```text
Use pull-work. Look at the configured work item backlog, respect WIP, reject vague items, check whether grouped items have a real dependency, decide whether to use a worktree, and prepare the plan-work handoff. Do not implement yet.
```

Expected behavior:

- inspect the configured work item backlog
- classify ready, blocked, stale, vague, or in-progress work
- prefer finishing active verification/review/CI work before starting new work
- select one thinnest meaningful slice or a justified work item group
- record the worktree decision
- stop before implementation unless you ask to continue

Expected artifact:

```text
.flow-agents/<slug>/<slug>--pull-work.md
```

When a repository has backlog provider settings, `pull-work` should use those settings without requiring the user to name the board. In Flow Agents, `npm run effective-backlog-settings -- --repo-path . --json` resolves `kontourai/flow-agents` to GitHub Project `kontourai/1`, so a prompt like `use pull-work` is enough for the configured provider path.

Direct `pull-work` remains a normal workflow primitive. The Builder Kit build path adds the pickup Probe/design-probe handoff before planning; it does not require Surface/Veritas trust-backed gates and does not replace direct primitive use.

Builder Kit build is the product-level entry point for implementation pickup. In that mode, `pull-work` may guide the next step automatically as `pull-work -> design-probe / pickup-probe`; direct `pull-work` still stops with a `plan-work` handoff unless you ask to continue.

If the board is empty or every issue is vague/stale, route back to Builder Kit shape / `idea-to-backlog`. Do not invent implementation work from an empty queue.

Before selecting new work, `pull-work` must separate your WIP from global conflict context:

- `my_active_work`: your local worktrees, dirty branches, open PRs, active sidecars, and in-flight review/verification/release work.
- `shepherding_candidates`: your work that should be reviewed, fixed, published, merged, abandoned, or cleaned before more work starts.
- `stale_worktrees`: worktrees that need an explicit keep/remove decision.
- `open_prs_by_me`: your open PRs with check/review state and next action.
- `global_conflicts`: work by others that overlaps files, contracts, dependencies, provider state, release lanes, or sequencing.
- `dependency_impacts`: blockers, blocked-by relationships, and work that changes what should be picked next.
- `start_new_work_decision`: whether to proceed, shepherd existing work, clean up, block, or ask the user.

Your WIP can block starting new work. Other people's WIP should block only when it creates concrete file-scope, dependency, sequencing, release, provider-state, or artifact-contract risk. Otherwise, record it as context for prioritization and coordination.

## 4. Plan And Execute Separately

After `pull-work` passes the pickup gate in the Builder Kit build flow, use the Builder Kit pickup Probe before planning. The Flow Definition step is named `design-probe`, and the build path is `pull-work -> design-probe -> plan`. The generic `design-probe` skill owns one-question-at-a-time design alignment; the `pickup-probe` skill is the Builder Kit work-item/docs/provider-grounded specialization used at that step.

The pickup Probe must record goal fit and scope, blockers and dependencies, dependency freshness, acceptance criteria quality, provider state, risk, stop-short risks, planning readiness, decisions, unresolved questions, accepted gaps, sandbox/worktree mode, expected modified files, and conflict risks. Record those in `.flow-agents/<slug>/<slug>--pull-work.md` or the plan handoff artifact before `plan-work` begins.

When the selected work item includes `planned_base_ref` and `planned_base_sha`, compare that base with current `main` before planning. If relevant files, contracts, docs, schemas, or dependency states changed since the work was shaped, classify the drift as `no_material_drift`, `scope_drift`, `dependency_drift`, `contract_drift`, or `conflict_risk`. Ask for alignment before planning when drift changes scope, acceptance criteria, dependency assumptions, or execution risk.

Provider-backed `plan-work` consumes that recorded freshness context before planning. The plan must name the latest target ref/SHA or accepted-gap fallback baseline used, then record which upstream acceptance criteria were revalidated against drift and which assumptions are now stale. Missing historical `planned_base_sha` is an accepted gap only when the fallback baseline is explicit; it is not a fresh baseline by itself.

For Builder Kit build, the handoff must also include machine-checkable fields:

- `probe_status`
- `probe_artifact_ref`
- selected item ids
- grouping decision
- accepted gaps
- route reason
- next action

Planning may proceed only when `probe_status` is `passed` or `accepted_gap`, and the selected item or justified group has fresh pickup Probe evidence. A previous broad instruction like "keep going" or "pick up the next two" can allow queue inspection, but it cannot authorize planning a newly selected item after merge.

Only ask an alignment question when repo/provider context still leaves a genuine decision gap. Ask one question at a time and include a recommended answer. If the user accepts proceeding with an unresolved question, record it as an accepted gap before planning.

Builder Kit workflow state follows `context/contracts/builder-kit-workflow-state-contract.md`. Keep `state.json` focused on phase/status/next action routing, and put rich selected-work, decision, unresolved-question, accepted-gap, missing-evidence, resume-prompt, expected-file, and conflict-risk data in the Builder Kit Probe record referenced by `state.json`, `handoff.json`, or the pull-work artifact.

Builder Kit build automation modes:

- `manual`: report state and next-step recommendation, then stop until the user asks to continue.
- `guided`: prepare the next step and proceed only when the artifact gate is clear or a gap is accepted.
- `strict`: block on missing required state, missing evidence, unresolved decisions, or invalid sidecars.
- `autonomous-bounded`: continue only inside the selected item/group, file ownership, sandbox, and Definition of Done; never select new work without fresh `pull-work` and `pickup-probe`.

Primitive recovery behavior:

- If a primitive has complete direct inputs, run the primitive and stop at its normal gate.
- If a primitive is missing required upstream state, explain the missing pre-step and offer the correct product-level entry point.
- If Builder Kit build reaches `plan-work` without pickup Probe evidence, route `decision_gap -> design-probe` and complete the pickup Probe before planning.
- If the user declines guided continuation, record `manual` mode and the expected next step so a later session can resume.

Per-item pickup Probe behavior:

- One item is the default after `pull-work`.
- Multiple items require an explicit independence or bundle justification plus expected conflict risks.
- Unsafe grouped work routes back to `pull-work` for splitting.
- After a merge, inspect the queue if asked, but create a fresh Probe record before planning any next item.

Then use `plan-work`.

Example prompt:

```text
Use plan-work for the selected work item in .flow-agents/<slug>/<slug>--pull-work.md. Produce an execution plan with acceptance criteria, file ownership, test strategy, and parallelization opportunities. Do not implement yet.
```

Then use `execute-plan` only after the plan is accepted.

Every plan must include a `Definition Of Done` section. This is where the agent calls out the user-facing outcome, acceptance evidence, known stop-short risks, and the durable docs target. If a plan only lists files and tasks, send it back before implementation.

Plans should preserve the work item's `R*` and `AC*` ids from `idea-to-backlog`. Execution waves must say which acceptance ids they support so verification and evidence gates can trace implementation back to the original shaped work.

Keep an isolated worktree alive through review, verification, provider change creation, and provider checks so the branch remains inspectable and fixable without disturbing the main checkout. Remove the worktree only after the change is merged or accepted, the branch is abandoned, or the user explicitly asks to collapse the isolation. Do not copy files back into the original checkout by hand; Git is the merge surface.

When `pull-work` chooses a worktree, record `worktree_lifecycle`: path, branch, retain-until condition, cleanup owner, cleanup command, and cleanup blockers. Publish-change retains the worktree for review/CI fixes; final acceptance or explicit abandonment owns cleanup.

Example prompt:

```text
Use execute-plan for .flow-agents/<slug>/<slug>--plan.md. Prefer isolated worktrees for parallel or risky work. Execute the plan and keep progress in the session artifact.
```

## 5. Review, Then Verify

Use `review-work` after implementation and before verification. Review is critique: it asks whether the code should change before you trust it.

Review checks quality, security triggers, architecture fit, project standards, risky assumptions, and maintainability. It writes `critique.json`. A clean review does not prove the feature works; it only says the implementation has no open reviewer findings that block the next gate.

Example prompt:

```text
Use review-work for .flow-agents/<slug>/<slug>--deliver.md. Run code review, security review if triggered, and standards/architecture critique. Record findings in critique.json. Do not fix code.
```

Then use `verify-work` for implementation verification. Verification is evidence: it asks what proves the accepted behavior works.

Verification runs build/type/lint/test/security/browser/runtime checks as relevant, maps results to acceptance criteria and Goal Fit, and writes `evidence.json`.

Example prompt:

```text
Use verify-work for .flow-agents/<slug>/<slug>--deliver.md. Map every acceptance criterion to evidence and record PASS, FAIL, or NOT_VERIFIED.
```

## 6. Build Trust With Evidence Gate

Use `evidence-gate` after verification to decide whether the evidence is trustworthy enough to publish, ask for review, or continue fixing.

Evidence Gate is not Release Readiness. It is the confidence gate for completed work: scope integrity, acceptance-to-evidence mapping, CI availability, weakened tests/config, and `NOT_VERIFIED` gaps. Its usual next step is `publish-change`, `verify-work`, `execute-plan`, or a human decision.

Example prompt:

```text
Use evidence-gate. Review the completed work, acceptance criteria, local verification, CI status, scope integrity, and any NOT_VERIFIED gaps. Do not fix code.
```

Expected behavior:

- map every acceptance criterion to evidence
- check the Goal Fit Gate against the original user outcome
- inspect CI or state what is missing
- flag weakened tests, changed requirements, skipped checks, or suspicious scope drift
- produce `PASS`, `FAIL`, or `NOT_VERIFIED`

When verification or evidence gates route work backward, the handoff must name both the route reason and the next action for the next agent. Use these Builder Kit route reasons consistently: `missing_evidence` returns to `verify-work`, `implementation_defect` returns to `execute-plan`, `plan_gap` returns to `plan-work`, and `decision_gap` returns to the `design-probe` step. Record the route reason in the evidence or handoff artifact, then state the exact next action needed before the gate can be retried.

For pickup or planning alignment gaps, `decision_gap -> design-probe` means returning to the pickup Probe record, resolving the missing decision or recording an accepted gap, and only then retrying `plan-work`.

Pickup Probe may update durable docs only when the decision is no longer a transient planning note. Use `CONTEXT.md` for glossary-style terminology decisions, create context files lazily only when a resolved term has no existing home, and create ADRs only for hard-to-reverse, surprising decisions that came from a real trade-off. Keep selected-work details, provider snapshots, unresolved questions, and accepted gaps in workflow artifacts until the work is accepted.

## 7. Check Goal Fit Before Stopping

Goal Fit is the local stop condition before a final answer. The working artifact in `.flow-agents/<slug>/` should answer:

- What did the user originally ask for?
- Can the user run, understand, inspect, or act on the result now?
- Are global and project-local scopes handled separately when relevant?
- Are remaining unknowns, `NOT_VERIFIED` items, or TODO gaps accepted explicitly?
- Does any UI/dashboard work have visual evidence?
- Is the docs target ready for final acceptance after CI/merge?

The `stop-goal-fit` hook also checks the latest workflow artifact and warns when the session is about to stop with missing `Definition Of Done`, incomplete Goal Fit, invalid sidecars, or open final acceptance work. Set `FLOW_AGENTS_GOAL_FIT_STRICT=true` to block incomplete local delivery. Set `FLOW_AGENTS_REQUIRE_SIDECARS=true` when structured workflow state should be mandatory. Set `FLOW_AGENTS_REQUIRE_CRITIQUE=true` when critique records should also be mandatory.

Use `npm run workflow:sidecar --` to create routine sidecars instead of hand-writing JSON:

```bash
npm run workflow:sidecar -- ensure-session \
  --source-request "<request>" \
  --summary "<summary>" \
  --criterion "<acceptance criterion>"

npm run workflow:sidecar -- init-plan .flow-agents/<slug>/<slug>--deliver.md \
  --source-request "<request>" \
  --summary "<summary>" \
  --next-action "<next step>"
```

Reviewer Markdown artifacts can be imported into `critique.json`:

```bash
npm run workflow:sidecar -- import-critique .flow-agents/<slug> .flow-agents/<slug>/<slug>--review.md
```

Core workflow skills should use these writer commands when available. If a writer command or validation is unavailable or blocked, the artifact should record the exact sidecar gap as `NOT_VERIFIED` rather than silently falling back to an unstructured pass.

Manual sidecar writing is an exceptional recovery path only. If `npm run workflow:sidecar --` cannot acquire `.workflow-sidecar.lockdir` with `EPERM` or `EACCES`, first fix the artifact directory permissions or ownership, or rerun the workflow in an approved writable workspace. If the writer is still blocked by local permissions or sandboxing, manually write only schema-valid sidecars, record the exact writer failure as `NOT_VERIFIED`, and run `npm run workflow:validate-artifacts -- --require-sidecars <artifact-dir>` before treating recovery as complete.

For substantial Flow Agents repo changes, maintainers can use the combined local evidence command after checks and critique are ready:

```bash
npm run workflow:sidecar -- dogfood-pass \
  --check-json '{"id":"focused-check","kind":"test","status":"pass","summary":"Focused check passed."}' \
  --require-critique \
  --critique-id "dogfood-review" \
  --critique-summary "Critique passed."
```

`dogfood-pass` is fail-closed: it refuses a clean pass without evidence and refuses required critique gaps before writing partial evidence. When the same clean pass is also merge-ready, add `--release-decision merge` and one or more `--release-doc-ref` values to write `release.json` in the same validated pass. Release decisions require passing critique.

Flow Agents source changes also have a deterministic CI baseline. Run it locally before publishing a branch when the change touches workflow contracts, hooks, package/bundle output, or Builder Kit behavior:

```bash
bash evals/ci/run-baseline.sh
```

The wrapper records command logs and Markdown provider evidence summaries under `evals/results/ci-baseline/`. GitHub Actions runs the same wrapper for pull requests, pushes to `main`, and manual dispatches across the `flow-agents-ci-source-and-static`, `flow-agents-ci-workflow-contracts`, and `flow-agents-ci-runtime-and-kit` artifacts. Evidence Gate should cite the provider check name, summary, and artifact when they exist. If the provider run is absent, pending, or failed, keep that status as `NOT_VERIFIED` for risky changes instead of treating local output as remote CI.

## 8. Publish The Verified Change

Release readiness needs a real published change and provider-check surface when the change risk requires it, not only local verification. The provider-neutral adapter contract is described in [Work Item And Change Adapters](work-item-adapters.html).

After `evidence-gate` is clean:

- commit the verified diff
- push the branch
- open or update the provider change record
- link the work item refs, workflow artifact, evidence artifact, and verification summary
- verify expected closing references when the provider supports them
- collect provider checks such as CI, status checks, required review, mergeability, policy, or deployment checks
- record missing provider checks as `not_verified` unless they are explicitly skipped under the risk policy

Example prompt:

```text
Use git and the configured ChangeProvider to publish this verified change. Confirm the diff is the verified scope, commit it, push the branch, open or update a change record with evidence links, check recognized closing references, and collect provider check status. Do not merge yet.
```

For GitHub, the `ChangeProvider` record is usually a pull request and provider checks are GitHub checks/reviews/mergeability. If no provider change is appropriate, record the reason explicitly before release-readiness.

Risk-based missing-check policy:

- Docs-only changes may pass with an explicit `skip` for missing provider checks when local docs review or focused validation is enough and the artifact records why.
- Runtime, schema, package, hook, security, migration, release, infrastructure, or deployment changes require provider check evidence or an explicit evidence-gate `not_verified` / release-readiness `hold`.
- Provider API failure, missing CI, missing required review, or unknown mergeability is not a clean pass for risky changes.
- Live GitHub mutation checks, LLM acceptance, and Veritas/governance provider evidence are not part of the default CI baseline. They must be explicitly invoked, skipped with rationale, or recorded as `NOT_VERIFIED` when the risk class requires them.

## 9. Decide Release Readiness

Release Readiness comes after the verified diff has been published or an explicit no-provider-change path has been recorded. It asks a different question from Evidence Gate: should this real branch/change be merged, released, deployed, held, or rolled back?

It checks operational concerns such as CI status, ownership, rollout timing, rollback, observability, release notes/docs, and post-deploy verification. Its output is a release decision, not just an evidence confidence verdict.

Use `release-readiness` after evidence is clean enough for a release decision and the verified change has been committed, pushed, and represented by a provider change record or explicit no-provider-change decision.

Example prompt:

```text
Use release-readiness for this evidence-gate PASS. Decide whether to MERGE, RELEASE, DEPLOY, HOLD, or mark ROLLBACK_REQUIRED. Check rollback, observability, ownership, docs, and post-deploy verification. Do not deploy.
```

## 10. Promote Final Acceptance Docs

`.flow-agents/<slug>/` is local runtime/session state by default in the Flow Agents source tree. Exported agent bundles may map the runtime root to a distribution-specific path through their bundle instructions. Treat local workflow roots as working memory for a delivery. After provider checks pass and the work is merged or otherwise accepted, promote the useful parts into durable documentation, provider comments/descriptions, release notes, or archive records.

Use the helper:

```bash
npm run promote-workflow-artifact -- .flow-agents/<slug>/<slug>--deliver.md
```

Expected behavior:

- copy the source artifact into `.flow-agents/<slug>/archive/<date>/`
- create or update a durable doc under `docs/delivery/`
- include the plan, evidence, Goal Fit, and Final Acceptance sections when present
- link the durable doc back to the archived artifact so future readers can inspect why and how the feature was built

Completion gate:

- `state.status` may be `delivered`, `accepted`, or `archived` with `phase: done` only when evidence is passing and either a promoted doc exists or the no-docs decision is explicit.
- `NOT_VERIFIED` evidence cannot be promoted as a clean delivery doc. Promote it as a blocked or partial record only if the doc names the gap and next owner.
- For adapter or provider work, the promoted doc should distinguish local/dry-run capability from live external mutation.
- Final delivery must reconcile sidecars before stopping: `acceptance.json`, `evidence.json`, and `release.json` are authoritative gate inputs. Temporary verifier-local mismatch notes are superseded only when the final orchestrator evidence or release validation names the reconciled sidecars. If Markdown and sidecars still disagree, hold the terminal delivery.
- Final acceptance should also close the active local state: after merge or accepted no-provider-change work, do not leave `state.status: verified` unless release, docs promotion, or learning still has an unresolved blocker.

The validator and stop hook enforce this shape for terminal workflows. If a delivery is terminal and neither the Markdown artifact nor `state.json.artifact_paths` points at durable docs, validation should fail unless the artifact records an explicit no-docs decision.

## 11. Capture Learning

Use `learning-review` after release, failed gates, incidents, repeated friction, or workflow gaps.

Example prompt:

```text
Use learning-review. CI flakes and a missing rollback note slowed this down. Separate facts from interpretation, route follow-ups to backlog/evals/docs/skills/knowledge, and do not implement fixes.
```

Learning review should resolve local WIP, not create a permanent local parking lot. Keep `learning.status: followup_required` only while a route still needs a decision. Once every route is completed, represented by a provider-backed issue, deferred with a concrete trigger, or rejected with a reason, record the learning as learned and advance the local workflow out of active state.

At terminal closeout, `learning-review` must compare intended behavior to observed behavior before recording `learning.json`. Clean runs record a lightweight no-correction-needed entry with `correction.needed: false`, brief `correction.evidence`, and closed routing such as `target: "none"`; do not invent a lesson just to fill the record. Mismatches record `correction.needed: true` with `correction.type`, stable `correction.recurrence_key`, intended behavior, observed behavior, gap, and either a prevention route or an explicit `no_change_rationale`.

Correction records live in `learning.json` for this slice. They are local workflow artifacts, not Console/dashboard UI, Source/Sink storage, or provider issue automation. The data contract unlocks future metrics such as correction rate, resolved corrections, repeated recurrence keys, stale unresolved corrections, and clean-run rate.

To publish local workflow-learning as Console-readable context, run:

```bash
flow-agents console-learning-projection --artifact-root .flow-agents --kontour-root .kontour
```

Those flags are the defaults. The command writes `.kontour/projections/flow-agents-learning/<scope-kind>-<scope-id>.json`. Generated learnings are inert, non-authoritative Console read models with `family: "workflow"` and `nonAuthority: true`. `learning.json` remains the Flow Agents-owned source data; the command does not mutate it, execute routing or prevention, create provider issues, implement Source/Sink storage, add UI, or model domain-learning. The producer performs minimal projection source-shape checks for required fields; full `learning.json` JSON Schema validation remains covered by `npm run workflow:validate-artifacts`. When a sibling Console checkout is available, `inspectLocalKontour` may inspect the generated projection, but Flow Agents local tests validate the committed projection shape.

For local-only users, `.flow-agents/<slug>/` is the recent recovery cache and queue dashboard. Retain active blockers and unresolved learning. Prune or archive routine successful runtime artifacts after 14-30 days once provider records, durable docs, or knowledge notes contain the useful history. Keep security, migration, release, or provider-governance evidence longer when auditability matters, usually 30-90 days unless a project policy says otherwise.

## Quick Prompt Templates

Start from raw ideas:

```text
Use idea-to-backlog. I have multiple ideas. Separate them, find the thinnest meaningful slice for each, challenge any accidental bundle, map dependencies, and stop before implementation.
```

Pick up work:

```text
Use pull-work. Select the next ready work item or justified work item group, enforce WIP, reject vague work, record worktree decision, and prepare a plan-work handoff.
```

Build confidence:

```text
Use evidence-gate. Map acceptance criteria to evidence, inspect CI and scope integrity, classify gaps as NOT_VERIFIED, and give a confidence verdict without fixing code.
```

Check local goal fit:

```text
Before final answer, update the Goal Fit Gate in the current `.flow-agents/<slug>/` delivery artifact. Keep working on unchecked items unless I explicitly accept them.
```

Release decision:

```text
Use release-readiness. Decide MERGE/RELEASE/DEPLOY/HOLD/ROLLBACK_REQUIRED based on evidence, rollback, observability, ownership, and post-deploy checks.
```

Retrospective:

```text
Use learning-review. Capture facts, decisions, gaps, follow-ups, and durable knowledge updates from this completed or failed workflow.
```
