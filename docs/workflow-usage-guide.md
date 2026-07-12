---
title: Workflow Usage Guide
---

# Workflow Usage Guide

> Consumer repositories and Builder skills use the supported public workflow
> surface and isolated exact-package launcher documented in
> [Public Workflow CLI](public-workflow-cli.md). Lower-level writer commands are
> package internals, not a supported agent or consumer interface.

This guide shows how to use the Builder Kit workflow skills in normal chats.

> **Which doc do I want?** This page is the *driver's manual* — what to say at each stage and what should happen. If you want the conceptual map first — layers, sidecars, hooks, evidence, and why the system is shaped this way — read the [Agent System Guidebook](agent-system-guidebook.md). For a one-line summary of every skill and gate, use the [Skills Map](skills-map.md). Flow Agents coordinates the local runtime, installs Flow Kits, and records artifacts; Flow owns gate semantics, including typed `expects` entries with `kind: "trust.bundle"`, trusted producer config, and gate overrides.

The core pattern is:

```text
ideas -> Builder Kit shape / idea-to-backlog -> work items -> pull-work -> pickup Probe / design-probe -> plan-work -> execute-plan -> review-work -> verify-work -> goal-fit -> evidence-gate -> publish-change -> release-readiness -> final-acceptance-docs -> learning-review
```

You can do this in one conversation, but the gates should stay explicit. Do not let shaping, planning, implementation, and release confidence blur into one continuous task.

Workflow artifacts follow a closeout lifecycle. Local runtime artifacts live under `.kontourai/flow-agents/<slug>/` and stay uncommitted. When a branch needs reviewable in-progress planning, promote durable behavior, decisions, evidence, and usage notes into long-lived docs, source, schemas, or provider records before merge.

For local artifact queue hygiene, run the read-only cleanup audit:

```bash
npm run workflow-artifact-cleanup-audit -- --artifact-root .kontourai/flow-agents
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

Separate these into distinct ideas, use Probe/alignment questions if the outcome or bundle is unclear, find the thinnest meaningful slice for each, push back if I bundle unrelated work, and stop at the backlog gate unless I explicitly ask you to sync configured provider work items (for example, GitHub issues).
```

Expected behavior:

- delegate shaping to `kits/builder/skills/idea-to-backlog/SKILL.md`
- link the artifact to the Builder Kit Flow Definition at `kits/builder/flows/shape.flow.json`
- start the public `builder.shape` Flow with a safe explicit slug, then inspect its public status before the step producer records evidence
- inventory each distinct idea separately
- classify each idea
- identify the thinnest meaningful slice
- shape executable work items with a readable story/outcome, scope, non-goals, stable `R*` requirement ids, stable `AC*` acceptance ids, verification expectation, milestone/delivery outcome, dependencies, and source artifact
- require bundle justification before grouping ideas
- map dependencies as blocking, blocked-by, or related-only
- stop at the backlog gate unless you explicitly ask to continue or explicitly request configured provider work-item sync; GitHub issue sync is an optional adapter example

Expected artifact:

```text
.kontourai/flow-agents/<slug>/<slug>--idea-to-backlog.md
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

Use `pull-work` when provider-backed work items already exist and you want to choose what to work on next. The public `builder.build` interface accepts exactly two Work Item reference forms: `provider:id` and `owner/repo#numeric-id`. The latter is a GitHub-compatible adapter form; do not invent arbitrary reference formats. GitHub issues remain an optional adapter example, not the core workflow vocabulary.

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
.kontourai/flow-agents/<slug>/<slug>--pull-work.md
```

When a repository has backlog provider settings, `pull-work` should use those settings without requiring the user to name the board. In this repository, the optional GitHub adapter resolves `kontourai/flow-agents` to GitHub Project `kontourai/1`, so a prompt like `use pull-work` is enough for that configured provider path.

### Assignment ownership: the third provider leg

Beside the `WorkItemProvider` (what work exists) and `BoardProvider` (how it is grouped/ranked) settings above, `pull-work` also reads `AssignmentProvider` settings to decide who currently owns a candidate work item before offering it. This is durable, human-visible ownership represented by the configured provider. For example, the optional GitHub adapter can use an issue assignee, an `agent:claimed` label, and a versioned machine-readable claim comment; tracker-less repos and evals can use an equivalent local JSON record. Join it against the ephemeral liveness presence layer so a crashed session's stale claim never blocks a second session from picking up the same work.

Settings live at `context/settings/assignment-provider-settings.json` (validated by `schemas/assignment-provider-settings.schema.json`), mirroring the same `defaults`/`projects[]` shape as the backlog provider settings above; resolve them with `npm run effective-assignment-provider-settings -- --repo-path . --json`. See `context/contracts/assignment-provider-contract.md` for the full `claim`/`release`/`supersede`/`status`/`list` vocabulary, the assignment ⋈ liveness join table, and the human-assignee ask-first policy.

Direct `pull-work` remains a normal workflow primitive. The Builder Kit build path adds the pickup Probe/design-probe handoff before planning; it does not require Surface/Veritas trust-backed gates and does not replace direct primitive use.

Builder Kit build is the product-level entry point for implementation pickup. In that mode, `pull-work` may guide the next step automatically as `pull-work -> design-probe / pickup-probe`; direct `pull-work` still stops with a `plan-work` handoff unless you ask to continue.

If the board is empty or every work item is vague/stale, route back to Builder Kit shape / `idea-to-backlog`. Do not invent implementation work from an empty queue.

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

The pickup Probe must record goal fit and scope, blockers and dependencies, dependency freshness, acceptance criteria quality, provider state, risk, stop-short risks, planning readiness, decisions, unresolved questions, accepted gaps, sandbox/worktree mode, expected modified files, and conflict risks. Record those in `.kontourai/flow-agents/<slug>/<slug>--pull-work.md` or the plan handoff artifact before `plan-work` begins.

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
Use plan-work for the selected work item in .kontourai/flow-agents/<slug>/<slug>--pull-work.md. Produce an execution plan with acceptance criteria, file ownership, test strategy, and parallelization opportunities. Do not implement yet.
```

Then use `execute-plan` only after the plan is accepted.

Every plan must include a `Definition Of Done` section. This is where the agent calls out the user-facing outcome, acceptance evidence, known stop-short risks, and the durable docs target. If a plan only lists files and tasks, send it back before implementation.

Plans should preserve the work item's `R*` and `AC*` ids from `idea-to-backlog`. Execution waves must say which acceptance ids they support so verification and evidence gates can trace implementation back to the original shaped work.

Keep an isolated worktree alive through review, verification, provider change creation, and provider checks so the branch remains inspectable and fixable without disturbing the main checkout. Remove the worktree only after the change is merged or accepted, the branch is abandoned, or the user explicitly asks to collapse the isolation. Do not copy files back into the original checkout by hand; Git is the merge surface.

After creating or entering a fresh worktree, run `npm ci` there before pre-push checks or evals; each worktree needs its own `node_modules`.

When `pull-work` chooses a worktree, record `worktree_lifecycle`: path, branch, retain-until condition, cleanup owner, cleanup command, and cleanup blockers. Publish-change retains the worktree for review/CI fixes; final acceptance or explicit abandonment owns cleanup.

Example prompt:

```text
Use execute-plan for .kontourai/flow-agents/<slug>/<slug>--plan.md. Prefer isolated worktrees for parallel or risky work. Execute the plan and keep progress in the session artifact.
```

## 5. Review, Then Verify

Use `review-work` after implementation and before verification. Review is critique: it asks whether the code should change before you trust it.

Review checks quality, security triggers, architecture fit, project standards, risky assumptions, and maintainability. In the active `verify` step, `review-work` owns `clean-critique` through public `workflow critique` in `trust.bundle`. A clean review does not prove the feature works; it only says the implementation has no open reviewer findings that block the next gate.

Example prompt:

```text
Use review-work for the current Builder session. Run code review, security review if triggered, and standards/architecture critique. Record findings through public workflow critique. Do not fix code.
```

Then use `verify-work` for implementation verification. Verification is evidence: it asks what proves the accepted behavior works.

Verification runs build/type/lint/test/security/browser/runtime checks as relevant, maps results to acceptance criteria and Goal Fit, and records command-backed evidence in `trust.bundle`. In the active `verify` step, `verify-work` owns `acceptance-criteria`, `tests-evidence`, and applicable `policy-compliance`.

Example prompt:

```text
Use verify-work for .kontourai/flow-agents/<slug>/<slug>--deliver.md. Map every acceptance criterion to evidence and record PASS, FAIL, or NOT_VERIFIED.
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

Pickup Probe may update durable docs only when the decision is no longer a transient planning note. Use `CONTEXT.md` for glossary-style terminology decisions, create context files lazily only when a resolved term has no existing home, and record decision subjects as decision-registry deltas (`docs/decisions/<slug>.md`, revise-vs-create against `docs/decisions/index.md`) rather than numbered ADRs — see `context/contracts/probe-docs-write-contract.md`. Keep selected-work details, provider snapshots, unresolved questions, and accepted gaps in workflow artifacts until the work is accepted.

## 7. Check Goal Fit Before Stopping

Goal Fit is the local stop condition before a final answer. The working artifact in `.kontourai/flow-agents/<slug>/` should answer:

- What did the user originally ask for?
- Can the user run, understand, inspect, or act on the result now?
- Are global and project-local scopes handled separately when relevant?
- Are remaining unknowns, `NOT_VERIFIED` items, or TODO gaps accepted explicitly?
- Does any UI/dashboard work have visual evidence?
- Is the docs target ready for final acceptance after CI/merge?

The `stop-goal-fit` hook also checks the latest workflow artifact and warns when the session is about to stop with missing `Definition Of Done`, incomplete Goal Fit, invalid sidecars, or open final acceptance work. Set `FLOW_AGENTS_GOAL_FIT_STRICT=true` to block incomplete local delivery. Set `FLOW_AGENTS_REQUIRE_SIDECARS=true` when structured workflow state should be mandatory. Set `FLOW_AGENTS_REQUIRE_CRITIQUE=true` when critique records should also be mandatory.

For an active Builder run, inspect and record evidence through the public CLI:

```bash
flow-agents workflow status --session-dir .kontourai/flow-agents/<slug> --json
flow-agents workflow evidence \
  --session-dir .kontourai/flow-agents/<slug> \
  --expectation <declared-expectation> \
  --status <pass|fail|not_verified> \
  --command "npm test" \
  --summary "The recorded command supports the declared expectation." \
  --evidence-ref-json '{"kind":"artifact","file":".kontourai/flow-agents/<slug>/<slug>--plan-work.md","summary":"Reviewable artifact for the declared expectation."}'

# For tests-evidence, repeat --criterion-json for every accepted criterion.
# Repeat --command and its matching top-level command ref when criteria use
# different checks.
flow-agents workflow evidence \
  --session-dir .kontourai/flow-agents/<slug> \
  --expectation tests-evidence \
  --status pass \
  --command "npm test" \
  --summary "Each accepted criterion has command-backed verification evidence." \
  --evidence-ref-json '{"kind":"command","excerpt":"npm test","summary":"Exact substantive project test command recorded for this verification result."}' \
  --criterion-json '{"id":"<criterion-id>","status":"pass","evidence_refs":[{"kind":"command","excerpt":"npm test","summary":"Exact substantive project test command run for this criterion."}]}' \
  --evidence-ref-json '{"kind":"artifact","file":".kontourai/flow-agents/<slug>/<slug>--plan-work.md","summary":"Criterion mapping and expected verification evidence."}'

flow-agents workflow critique \
  --session-dir .kontourai/flow-agents/<slug> \
  --verdict <pass|fail|not_verified> \
  --summary "Report-only critique findings and gaps are recorded." \
  --artifact-ref ".kontourai/flow-agents/<slug>/<slug>--deliver.md" \
  --artifact-ref "<reviewed-changed-file>" \
  --lane-json '{"id":"code-review","status":"pass","summary":"Code quality, correctness, architecture, and standards were reviewed.","evidence_refs":[{"kind":"artifact","file":".kontourai/flow-agents/<slug>/<slug>--deliver.md","summary":"Reviewed delivery artifact and changed-scope context."}]}'
```

Only the step skill declared for that Flow expectation should publish it.
Run authenticated critique before `tests-evidence`; the delegated reviewer
invokes the public critique command under a runtime identity distinct from the
active implementation actor. The command does not accept a caller-selected
reviewer identity.
Every critique must include at least one substantive lane. A passing critique
must also cite the delivery report and reviewed changed files. Stored file
hashes and the workspace snapshot prevent later implementation changes from
inheriting a stale clean review.
Entrypoints, profiles, shared primitives, and extensions do not claim step-gate
completion. `review-work` owns only `clean-critique`; `verify-work` owns
`acceptance-criteria`, `tests-evidence`, and applicable `policy-compliance`.

### Package Maintainer Internals

The following writer details explain existing package implementation and
maintenance tests. They are not Builder skill or consumer commands. Skills use
the public CLI shown above and treat an unavailable public operation as a
blocker or `NOT_VERIFIED` gap.

The package's internal writer can create and validate projected artifacts:

```bash
npm run workflow:sidecar -- ensure-session \
  --source-request "<request>" \
  --summary "<summary>" \
  --criterion "<acceptance criterion>"

npm run workflow:sidecar -- init-plan .kontourai/flow-agents/<slug>/<slug>--deliver.md \
  --source-request "<request>" \
  --summary "<summary>" \
  --next-action "<next step>"
```

#### Deterministic slug from a work-item ref

For work-item-backed sessions, use one of the two supported reference forms:
`provider:id` or `owner/repo#numeric-id`. The latter is the GitHub-compatible
adapter form; do not use other formats. `--task-slug` is reserved for an
existing local Work Item retry. The internal writer derives a deterministic slug
from either supported form; the GitHub-compatible example has the format
`<owner>-<repo>-<id>`:

```bash
npm run workflow:sidecar -- ensure-session \
  --work-item "kontourai/flow-agents#161" \
  --source-request "Implement #161" \
  --summary "Deterministic slug demo."
# Creates .kontourai/flow-agents/kontourai-flow-agents-161/
```

The slug is deterministic and idempotent: any agent or worktree that runs `ensure-session
--work-item kontourai/flow-agents#161` will land in the same directory. This makes liveness
collision-detection work correctly — the `subjectId` written to `liveness/events.jsonl` equals
`workItemSlug(ref)` (i.e. `kontourai-flow-agents-161`), so a double-hold on the same issue is
detectable via `liveness status --subject kontourai-flow-agents-161` (see
[ADR 0012](adr/0012-agent-coordination-as-liveness-claims.md)).

Rules:
- `--task-slug` always wins when both flags are supplied (back-compat).
- Omitting both flags still dies with `--task-slug is required`.
- In `owner/repo#numeric-id`, the id after `#` must be a plain integer. In
  `provider:id`, the provider and id must use the provider-neutral reference
  grammar; nonconforming or arbitrary formats are rejected.
- Work-item-backed sessions should prefer `--work-item` over hand-supplied `--task-slug` so that
  liveness subjectId alignment is automatic.

#### Branch convention

`ensure-session` derives a routing branch name for every newly created session and records it
in `state.json.branch`, seeds it into the session Markdown's `branch:` line, and mirrors it into
`current.json.branch` for the currently active session. The derived format is:

```
agent/<actor>/<slug>
```

`<actor>` comes from the same actor resolver used by liveness tracking
(`scripts/hooks/lib/actor-identity.js`'s `resolveActor`), and `<slug>` is the session's task slug
(or the deterministic `--work-item` slug described above).

Neither the resolved actor string nor an arbitrary `--task-slug` is guaranteed to be a valid git
ref component, so `ensure-session` runs both through an incremental `sanitizeBranchSegment` pass
before joining them into `agent/<actor>/<slug>`:

1. Replace any `:` with `-` (the actor resolver's own `:` delimiter is not a legal ref character).
2. Re-run the actor resolver's own charset restriction (`[A-Za-z0-9_.-]`, 64-char cap).
3. Collapse repeated `..` sequences to a single `-` (git forbids two consecutive dots in a ref
   component).
4. Strip a leading `.` (git forbids a component starting with `.`).
5. Strip a trailing `.` (fix-plan iteration 1, F1 — git forbids a component ending in `.`; the
   prior pass only handled a run of 2+ trailing dots via the `..`-collapse step above and missed
   the single-trailing-dot case, e.g. a `--task-slug` of `my-fix.`). This runs *before* the next
   step so a `.lock` suffix hidden behind trailing dots (e.g. `foo.lock.`) is exposed and still
   rewritten rather than left dangling.
6. Rewrite a trailing `.lock` to `-lock` (git forbids a component ending in `.lock`).
7. If the FINAL result after the above steps is empty, OR is exactly the literal string
   `unknown`, fall back to `unknown-<hash>` where `<hash>` is the first 6 hex characters of
   `sha256(<raw input before step 1>)` (fix-plan iteration 1 F4, tightened by iteration 2 F4').
   The hash is deterministic (same raw input always derives the same fallback, preserving the
   "never re-derive an existing session's branch" guarantee below) but makes two *different*
   raw inputs that both land on the fallback derive distinct branches instead of silently
   colliding on the bare literal `unknown`. This covers three distinct ways a raw input can land
   on the fallback, all disambiguated identically with **no exceptions**: an all-garbage input
   (e.g. `--task-slug "???"`) whose charset filter in step 2 collapses it to nothing; a near-miss
   input like `"unknown."` or `".unknown"` that step 4/5's leading/trailing-dot stripping
   collapses down to the literal `unknown`; and a raw input that genuinely *is* the literal
   string `unknown` verbatim. Iteration 1 exempted that last case (a literal `"unknown"` input
   was left undisambiguated); iteration 2 (F4') removed that carve-out because it let a literal
   `--actor unknown` collide, undisambiguated, with a near-miss input like `"unknown."` that
   collapses to the same segment — every input that reaches the fallback token is now
   disambiguated uniformly.

As of fix-plan iteration 1 (re-verified against the sanitizer above, see F1 in
`.kontourai/flow-agents/kontourai-flow-agents-289/kontourai-flow-agents-289--fix-plan-iteration-1.md`),
this pass empirically closes every concrete git-check-ref-format(1) failure mode reachable
through it: `sanitizeSegment`'s own `[A-Za-z0-9_.-]` charset restriction (step 2) already strips
every character git-check-ref-format forbids elsewhere in a ref component — `@`, `{`/`}` (so
`@{` cannot survive), `/` (so a derived segment can never end with `/`, contain `//`, or itself
be a bare `@`), whitespace, and other control characters — so none of those were ever actually
reachable in a *derived* segment even before this iteration; only the single-trailing-dot case
(step 5, above) was a real, reachable gap, and it is now closed. There is no longer a known
accepted gap for the derived path. This is still not a from-scratch reimplementation of
`git-check-ref-format(1)` (e.g. it has not been exhaustively fuzzed against every future git
version's rule set) — but it is not a partial/best-effort pass either.

- Pass `--branch <value>` to `ensure-session` to record an explicit value verbatim instead of the
  derived name. The override only applies while creating a brand-new session.
- Unlike the derived path, an explicit `--branch` is **not** sanitized — it is caller intent and
  may legitimately contain `/` (to nest under an existing convention), so `ensure-session`
  strictly *validates* it instead and dies with a remediation message, before writing any session
  artifact. Validation runs in two passes:
  1. Whole-string lexical checks (fix-plan iteration 1, F2) — the value must not:
     - contain a control character, newline, or space;
     - start or end with `/`, or contain `//`;
     - start with `.`, or contain a `..` sequence;
     - end with `.` or `.lock`; or
     - contain any character outside `[A-Za-z0-9_./-]`.
  2. Per-`/`-component lexical checks (fix-plan iteration 2, F2') — the whole-string checks above
     only examine the very start/end of the full value, so a charset-legal value can still smuggle
     an invalid path component past them (e.g. `-lead`, `a/.b`, `foo.lock/bar`, `a/./b`). Every
     `/`-delimited component must not be empty, must not be exactly `.`, must not start with `.`
     or `-` (applied uniformly to every component, not just the first — intentionally stricter
     than git strictly requires, which is fine for a caller-facing override flag), and must not
     end with `.` or `.lock`.
  3. Belt-and-braces (fix-plan iteration 2, F2'): once both lexical passes above succeed, the real
     `git check-ref-format --branch <value>` binary is invoked (argv-array, no shell, 5-second
     timeout) as the final authority. It can only ever *reject* a value the lexical checks already
     let through — never re-legalize one they rejected — so it closes any residual gap between this
     hand-rolled lexical pass and git's actual ref-name rules. When git cannot be spawned at all
     (not installed) or does not complete within the timeout, this step is skipped silently and the
     lexical checks above remain the sole authority.

  A value that passes all of the above is recorded exactly as given (no trimming, no
  sanitization).
- `ensure-session` only records the branch **name** — in `state.json`, the session Markdown, and
  `current.json`. It does not run `git checkout -b` or `git worktree add`; creating and checking
  out the actual branch/worktree remains the calling skill's responsibility (see
  [ADR 0021](adr/0021-assignment-leases-and-stale-claim-takeover.md) §3).
- Resuming an existing session directory never re-derives or overwrites its already-recorded
  `branch` — the session Markdown's existing `branch:` line always wins, regardless of which
  actor next calls `ensure-session` against that slug. This is what makes takeover continuity
  ("resume the incumbent's branch, never a parallel one") true by construction; see
  [ADR 0021](adr/0021-assignment-leases-and-stale-claim-takeover.md) §5.
- `branch` is an optional field in `workflow-state.schema.json` for migration honesty: legacy
  `state.json` files that predate this convention have no `branch` key and still validate.
  `workflow:validate-artifacts` prints a non-blocking `WARN` line to stderr (not a hard failure)
  when a `state.json` has no `branch` field, naming the gap without breaking legacy
  sessions/fixtures.

Reviewer Markdown can be retained as a linked reference, but the public
`workflow critique` operation is the only Builder review-recording interface.

Package integration tests use these writer commands to exercise projection
internals. Core workflow skills must use `flow-agents workflow`; if its required
operation is unavailable or blocked, record the exact gap as `NOT_VERIFIED`
rather than silently falling back to an internal command or unstructured pass.

Manual sidecar writing is an exceptional recovery path only. If `npm run workflow:sidecar --` cannot acquire `.workflow-sidecar.lockdir` with `EPERM` or `EACCES`, first fix the artifact directory permissions or ownership, or rerun the workflow in an approved writable workspace. If the writer is still blocked by local permissions or sandboxing, manually write only schema-valid sidecars, record the exact writer failure as `NOT_VERIFIED`, and run `npm run workflow:validate-artifacts -- --require-sidecars <artifact-dir>` before treating recovery as complete.

The combined internal writer fixture below is documented only for maintainers
of its integration tests. It is not a Builder workflow operation:

```bash
npm run workflow:sidecar -- dogfood-pass \
  --check-json '{"id":"focused-check","kind":"test","status":"pass","summary":"Focused check passed."}' \
  --require-critique \
  --critique-id "dogfood-review" \
  --critique-verdict pass \
  --critique-summary "Critique passed." \
  --artifact-ref ".kontourai/flow-agents/<slug>/<slug>--deliver.md" \
  --lane-json '{"id":"code-review","status":"pass","summary":"Focused review completed.","evidence_refs":[{"kind":"artifact","file":".kontourai/flow-agents/<slug>/<slug>--deliver.md","summary":"Reviewed dogfood delivery artifact."}]}'
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

`.kontourai/flow-agents/<slug>/` is local runtime/session state by default in the Flow Agents source tree. Exported agent bundles may map the runtime root to a distribution-specific path through their bundle instructions. Treat local workflow roots as working memory for a delivery. After provider checks pass and the work is merged or otherwise accepted, promote the useful parts into durable documentation, provider comments/descriptions, release notes, or archive records.

Use the helper:

```bash
npm run promote-workflow-artifact -- .kontourai/flow-agents/<slug>/<slug>--deliver.md
```

Expected behavior:

- copy the source artifact into `.kontourai/flow-agents/<slug>/archive/<date>/`
- create or update a durable doc under `docs/delivery/`
- include the plan, evidence, Goal Fit, and Final Acceptance sections when present
- link the durable doc back to the archived artifact so future readers can inspect why and how the feature was built

Completion gate:

- `state.status` may be `delivered`, `accepted`, or `archived` with `phase: done` only when evidence is passing and either a promoted doc exists or the no-docs decision is explicit.
- `NOT_VERIFIED` evidence cannot be promoted as a clean delivery doc. Promote it as a blocked or partial record only if the doc names the gap and next owner.
- For adapter or provider work, the promoted doc should distinguish local/dry-run capability from live external mutation.
- Final delivery must reconcile `trust.bundle` before stopping. Temporary verifier-local notes are superseded only when the final public evidence or release validation names the reconciled trust slices. If linked reports and the bundle disagree, hold the terminal delivery.
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

For local-only users, `.kontourai/flow-agents/<slug>/` is the recent recovery cache and queue dashboard. Retain active blockers and unresolved learning. Prune or archive routine successful runtime artifacts after 14-30 days once provider records, durable docs, or knowledge notes contain the useful history. Keep security, migration, release, or provider-governance evidence longer when auditability matters, usually 30-90 days unless a project policy says otherwise.

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
Before final answer, update the Goal Fit Gate in the current `.kontourai/flow-agents/<slug>/` delivery artifact. Keep working on unchecked items unless I explicitly accept them.
```

Release decision:

```text
Use release-readiness. Decide MERGE/RELEASE/DEPLOY/HOLD/ROLLBACK_REQUIRED based on evidence, rollback, observability, ownership, and post-deploy checks.
```

Retrospective:

```text
Use learning-review. Capture facts, decisions, gaps, follow-ups, and durable knowledge updates from this completed or failed workflow.
```

## Resumable sessions

Builder build sessions also project their canonical Flow run into the resume block.
Start a newly selected session with `flow-agents workflow start --flow builder.build
--work-item <provider-ref> --assignment-provider <configured-kind>` and add
`--effective-state-json <provider-status.json>` for a non-local provider, where `<provider-ref>` is exactly `provider:id` or
`owner/repo#numeric-id`; the latter is the GitHub-compatible adapter form. The
adapter supplies the stable, human-readable Work Item reference. Thereafter, follow `next_action.skills` or `next_action.operations` and record the
current gate through the public `workflow evidence` command. After interruption, inspect
the read-only `workflow status` projection without attaching evidence or advancing the run. See
[`docs/spec/builder-flow-runtime.md`](spec/builder-flow-runtime.md) for the ownership,
trust-binding, route-back, and artifact-root contract.

If the same Builder slice is interrupted, inspect its canonical status. Resume
only when the public status reports a paused run:

```bash
flow-agents workflow status --session-dir .kontourai/flow-agents/<slug> --json
flow-agents workflow resume --session-dir .kontourai/flow-agents/<slug> --reason "Continue the bound work item"
```

The session slug is the run identity. Do not select a different run, force a
step, or use an internal synchronization command to bypass the canonical next
action.

When a session resumes (after context compaction, an agent restart, or a cross-session
handoff), the workflow-steering hook emits a `RESUME:` block on `SessionStart` that
gives the resuming agent immediate situational awareness without blocking or auto-deciding.

The `RESUME:` block supplements the existing `STATE:` line and contains:

- **Header** — `RESUME: <slug> status:<status> phase:<phase>` — quick orientation.
- **Next action** — the full `next_action.summary` at 240 characters (not truncated to 80), so the agent can re-ground to the exact recorded next step.
- **Plan** — path to the plan artifact (`<slug>--plan-work.md` from `state.json artifact_paths` or conventional fallback).
- **Next step** — the first `handoff.json next_steps` entry.
- **Blockers** — any recorded blockers from `handoff.json`, or "none".
- **Trust** — `Trust: N verified / M disputed / T total` from reading `trust.bundle`. Each disputed or unknown claim names the owning expectation so its step producer can attach resolving evidence through `flow-agents workflow evidence`.
- **Liveness advisory** (when applicable) — `[LIVENESS WARNING: another agent appears live on this work: actor <X>, last seen <T>]` when the shared liveness stream (`.kontourai/flow-agents/liveness/events.jsonl`, ADR 0012) contains a fresh claim or heartbeat from a different actor for the same slug. This is advisory only — the hook exits 0 regardless. The block also always includes an `ACTOR: <actor> (<source>)` line — the same runtime-agnostic actor identity this session resolves for itself (see "Actor identity and liveness writes" below), so a resuming agent can see at a glance which identity its own liveness claims/heartbeats will be filed under.
- **Route hint** — `To continue: resume this work. Or run pull-work to assess WIP and start new/parallel work.` — always routes the resume-vs-parallel decision through `pull-work` rather than auto-taking it.

The `RESUME:` block appears on `SessionStart` only. `UserPromptSubmit` and `PostToolUse`
behavior is unchanged.

All reads are fail-open: a missing `handoff.json`, `trust.bundle`, or liveness stream
degrades gracefully — the section is omitted or shows "no data", and the hook never throws.

The `RESUME:` advisory read above is read-only (ADR 0012); liveness *writes* happen
elsewhere in the lifecycle and already exist today: `init-plan` claims the active slug and
`advance-state` heartbeats/releases it. As of #288, `FLOW_AGENTS_LIVENESS` defaults **on** —
presence is ambient by default. Set it to `off`/`0`/`false`/`no`/`disabled`
(case-insensitive) to opt back out. Claim TTL defaults to `1800` seconds and is
configurable via `FLOW_AGENTS_LIVENESS_TTL_SECONDS`; per ADR 0012 §4, tuning this value is
itself the operational risk — too tight manufactures false reclaims, so treat liveness as
advisory and double-check against real branch/PR state before tightening it. A throttled
tool-activity heartbeat also rides ordinary tool use (see "Tool-activity heartbeat"
below), so a long-running wave never goes stale on TTL alone just because it hasn't hit a
phase transition. The session-level event log (Layer 2) is still deferred.

### Shared liveness helper

The freshness logic is centralised in `scripts/hooks/lib/liveness-read.js` (pure CJS,
zero dependencies). It exports:

- `readLivenessEvents(streamPath)` — reads a `.kontourai/flow-agents/liveness/events.jsonl` file
  line-by-line, JSON-parses each, and tolerates malformed lines.
- `freshHolders(events, slug, selfActor, nowMs)` — returns actors (excluding `selfActor`)
  who hold a within-TTL claim or heartbeat on `subjectId === slug`.

Both the hook (`scripts/hooks/workflow-steering.js`) and the compiled CLI
(`build/src/cli/workflow-sidecar.js`) consume this helper so the TTL/freshness logic lives
in one place.

### Tool-activity heartbeat

`scripts/hooks/lib/liveness-heartbeat.js` (pure CJS, zero dependencies — same sharing pattern
as `liveness-read.js` and `actor-identity.js`) exports `maybeEmitHeartbeat({ cwd, env, now })`.
All four telemetry hook wrappers (`scripts/hooks/{claude,codex,opencode,pi}-telemetry-hook.js`)
call it whenever the current invocation's canonical event resolves to `postToolUse`. Per
[`docs/spec/runtime-hook-surface.md`](spec/runtime-hook-surface.md) row 280, `PostToolUseFailure`
is a **Claude Code-only** additional native event mapped onto canonical `postToolUse` — Codex,
Kiro, opencode, and pi each map only their own single native `postToolUse`-equivalent event
(`PostToolUse`, `PostToolUse`, `tool.execute.after`, `tool_result` respectively); no other
runtime has a distinct "failure" variant. The heartbeat call runs independently of the existing
`telemetry.sh` spawn. On each call it:

1. Checks `isLivenessEnabled()` — no-ops (`disabled`) if `FLOW_AGENTS_LIVENESS` is off.
2. Reads `current.json`'s `active_slug` and resolves the actor (`actor-identity.js`) — no-ops
   if there is no active slug or the actor cannot be resolved. These two checks run *before*
   actor resolution specifically so a repo with liveness disabled, or with no active session,
   never pays the actor resolver's process-ancestry `ps` spawn cost.
3. Reads a **bounded tail** (the last 64KB, newline-aligned so a partial line at the truncation
   boundary is dropped) of the `liveness/events.jsonl` stream, filtered for that
   `(subjectId, actor)` pair. Because the stream is append-only, this bounded read is exact for
   any pair whose most recent event lies within that window — which, in steady state, is always
   true within one throttle period. Only if the pair has **zero** matching events anywhere in
   the tail (the rare case of the first heartbeat after a claim old enough to have scrolled out
   of the last 64KB) does it fall back to one full read of the stream. No-ops if there is no
   prior `claim` event from this actor for this subject, or if the actor's most recent event for
   the subject is a `release`.
4. Throttles: only appends a new `heartbeat` event once at least
   `FLOW_AGENTS_LIVENESS_HEARTBEAT_THROTTLE_SECONDS` (default `60`) seconds have elapsed since
   that actor's last recorded event for the subject.

The throttle window is derived from the actor-scoped stream tail itself — there is
deliberately no separate, mutable "last heartbeat" state file. Per ADR 0021 §3 (which lists
"advance-state + tool activity" heartbeats as one of the cross-cutting liveness touchpoints,
riding existing writes rather than a bespoke timer), a shared state file keyed on anything
less specific than the actor would reintroduce the same last-writer-wins race that ADR 0021
is designed to close. Each actor only ever contends with its own prior writes, so there is no
cross-session race to guard against.

`maybeEmitHeartbeat` is fail-open, matching the #287 actor-identity convention below: any
error is caught, a diagnostic is written to stderr, and the call returns without throwing — it
never blocks the tool call, never alters a wrapper's stdout/success-output shape, and never
changes a wrapper's exit code. It also does not read or depend on `TELEMETRY_ENABLED` —
disabling telemetry does not disable liveness heartbeats, and vice versa; the two are
independent, sibling concerns.

### Overlap detection and correction

Two composable mechanisms (#320) tighten the gap ADR 0012 §4 names — a false-stale
double-hold is *detected*, not *prevented*, and liveness stays advisory, never a lock: a
deterministic **tiebreaker CLI** (`liveness verdict`) that lets a losing session
self-correct within the same `pull-work` pass, and a **mid-turn conflict injection** that
surfaces another actor's fresh claim on a session's own held subject inside its own
tool-call context, on the runtimes whose hook contract supports it. Neither mechanism
mutates GitHub/provider state or introduces a new state file (ADR 0012 §5); each closes
one of the cross-cutting liveness touchpoints ADR 0021 §3 lists, without implementing
that ADR's still-Draft takeover/supersede or publish-gate slices.

The table below documents the full selection/mid-flight/publish latency budget — where a
double-hold can occur, what detects it, what corrects it, and the typical latency before
correction happens:

| Window | What can go wrong | Detector | Corrector | Typical latency |
| --- | --- | --- | --- | --- |
| **Selection** | Two sessions both select and claim the same subject in the same narrow read-then-write window (#166). | `pull-work`'s preflight (`### 1a. Liveness Selection Preflight`) plus its post-claim re-check (`### Post-Claim Conflict Re-check`), both reading `liveness status`. | `liveness verdict` computes the deterministic winner; the losing session runs `liveness release` and returns to `### 3. Select Work` to reselect in the same pass (#320). | One `pull-work` pass — seconds. |
| **Mid-flight** | After selection, another actor claims the same subject while this session is mid-execution, before its next natural checkpoint. | The tool-activity heartbeat's bounded tail read (#288), extended to also run the conflict check on the same in-memory buffer, zero added I/O (#320). | Claude Code and Codex: mid-turn hook feedback (`hookSpecificOutput.additionalContext`) surfaced on the very next tool call. opencode and pi: a stderr diagnostic only today (their generated plugin/extension does not consume telemetry-wrapper stdout — a disclosed gap, tracked in #333, not closed by this issue); all four runtimes still fall back to the pre-existing next-turn `workflow-steering.js` `[LIVENESS WARNING: ...]` digest. | Claude Code/Codex: next tool call. opencode/pi: next `SessionStart` or a manual check, plus the stderr diagnostic at the time of the conflicting tool call. |
| **Publish** | Two sessions both believe they hold exclusive claim at the moment of publish (merge/release). | Not yet implemented. | Not yet implemented — the `verify-hold` publish gate (ADR 0021 §3, tracked as #293). | Would be blocking, at publish time. |

The Publish row is **not implemented by this issue** — it is named here so the table is
read as an honest latency-budget map, not mistaken for a claim that overlap detection is
fully closed end-to-end. See [ADR 0012](adr/0012-agent-coordination-as-liveness-claims.md)
§4 and [ADR 0021](adr/0021-assignment-leases-and-stale-claim-takeover.md) §3 for the
underlying design rationale.

### Actor identity and liveness writes

Liveness claims/heartbeats/releases are attributed to a runtime-agnostic **actor struct**
`{runtime, session_id, host, human?}`, serialized (via `serializeActor()` in the shared
`scripts/hooks/lib/actor-identity.js` resolver — same sharing pattern as `liveness-read.js`
above) into a single string safe for the existing `${subjectId}::${actor}` grouping key. The
serialized actor string embeds this machine's `os.hostname()` — so `liveness/events.jsonl` (and
therefore `.kontourai/flow-agents/` as a whole) can indirectly reveal hostnames of every host
that has claimed work in this repo; `.kontourai/` must stay gitignored (it already is, by
default) and must never be force-added (`git add -f`) or bundled into a shareable support
bundle without first reviewing it for this kind of incidental host-identifying information. Both
`workflow-sidecar`'s `liveness` command and `workflow-steering.js`'s SessionStart advisory
consume the same `resolveActor()` function, so a session's own claim/heartbeat events are
never mistaken for "another agent."

`resolveActor()` derives the actor automatically, with zero required configuration, via a
priority chain:

1. An explicit `FLOW_AGENTS_ACTOR` env override, if set (and not the literal `"local"`,
   case-insensitive) — always wins.
2. A runtime-native session-id env var already ambient in the current process's own
   environment — confirmed for Claude Code (`CLAUDE_CODE_SESSION_ID`); the equivalent var for
   Codex/opencode/pi is unverified as of this writing.
3. A process-ancestry fallback (the resolver's parent PID plus that parent process's exact
   start timestamp, hashed into a short opaque token) — needs no runtime cooperation, is
   stable across repeated invocations within one session, and is distinct across concurrent
   sessions on one host. This is the correctness backstop for runtimes whose native
   session-id env var is not yet confirmed.

**Liveness writes fail loud.** `liveness claim`, `liveness heartbeat`, and `liveness release`
exit nonzero with remediation text whenever the resolved actor is empty or the literal
`"local"` (case-insensitive) — they never silently fall back to the old shared `"local"`
default. Fix: pass `--actor <id>` explicitly, set `FLOW_AGENTS_ACTOR=<id>`, or run inside a
supported runtime so the derivation chain above can resolve a real identity.

**Liveness reads stay backward-compatible.** `liveness status` and `freshHolders()` (in
`liveness-read.js`) continue to parse, group, and label pre-existing events whose `actor`
field is the literal string `"local"` without error or behavior change — only *new* writes
are rejected, not historical data.

This actor struct is the same shape referenced by
[ADR 0012](adr/0012-agent-coordination-as-liveness-claims.md) and by
[ADR 0021](adr/0021-assignment-leases-and-stale-claim-takeover.md) §2 (`AssignmentProvider`)
as the forward-looking identity model for durable assignment. ADR 0021 is still Draft, and its
other slices (`AssignmentProvider`, the janitor, takeover/supersede, the verify-hold publish
gate) are **not** implemented by this change — only the actor struct and derivation chain
described here.
