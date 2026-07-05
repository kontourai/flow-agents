---
name: "deliver"
description: "Delivery workflow — selected work to delivered code. Ensures pull-work + pickup-probe preflight, then chains plan-work → execute-plan → review-work → verify-work → loop on failure without requiring user interaction between cleanly determined stages."
---

# Deliver

Takes a goal, chains the three primitives, loops until the user-facing goal is met. The orchestrator coordinates — it never touches source files.

## Agents

Inherited from primitives:

| Agent | Used by |
|---|---|
| tool-planner | plan-work |
| tool-worker (x4) | execute-plan |
| tool-code-reviewer | review-work |
| tool-security-reviewer | review-work (conditional — security-sensitive changes) |
| tool-verifier | verify-work |
| tool-playwright | verify-work |

## Model Routing

Delegates are spawned with an explicit model override resolved from
`.datum/config.json` via `npx @kontourai/datum resolve <role> --json`
(see `context/contracts/execution-contract.md` § Delegation: Model Routing —
that contract is the consumption instruction, `.datum/config.json` is the
source of truth for the mapping):

| Delegate | Role |
|---|---|
| tool-worker | `delegate-mechanical` for fully-specified mechanical tasks, `delegate-implementation` for precisely-planned implementation, `delegate-design` when the task needs design latitude |
| tool-planner | `delegate-design` |
| tool-code-reviewer / tool-security-reviewer | `delegate-implementation` by default, raised to the worker's tier when higher — never below the tier of the checked work (Goodhart guard) |
| tool-verifier / tool-playwright | `delegate-implementation` by default, raised to the worker's tier when higher — never below the tier of the checked work (Goodhart guard) |

On a review/verify gate failure, re-dispatch the fix one tier higher on the
ladder and record the escalation in the session artifact via
`record-agent-event --kind escalation --role <higher> --escalated-from <lower>`
(see `context/contracts/execution-contract.md` § Escalation on gate failure and
§ Routing decisions in the run artifact). If datum or the config is absent, fall
back to the runtime's inherited model and note the fallback in the session
artifact.

## Orchestrator Rule

You never use `read`, `glob`, `grep`, or `code` on source files. You only read/write the session file and artifact files in `.kontourai/flow-agents/<slug>/`.

## Shared Contracts

Follow:
- `context/contracts/standing-directives.md`
- `context/contracts/artifact-contract.md`
- `context/contracts/planning-contract.md`
- `context/contracts/execution-contract.md`
- `context/contracts/review-contract.md`
- `context/contracts/verification-contract.md`
- `context/contracts/delivery-contract.md`

This skill owns orchestration across the full loop. The contracts own artifact shape, Definition Of Done, execution handoff, verification verdicts, Goal Fit, and Final Acceptance.

When you report progress or final evidence, use exact delegate ids such as `tool-planner`, `tool-worker`, `tool-verifier`, and `tool-playwright`. Do not collapse them to generic labels when the gate is part of acceptance evidence.

## Sidecar Writer Adoption

When the repository provides `npm run workflow:sidecar --`, use it for routine workflow state instead of hand-writing JSON:

- `ensure-session` before planning starts
- `current --format path` when resuming or handing work to delegates
- `record-agent-event` for delegated progress, handoffs, blockers, and evidence pointers
- `advance-state` at each phase transition
- `record-evidence` after verification
- `record-critique` or `import-critique` after review
- `record-release` for release-readiness decisions
- `record-learning` for learning-review outcomes
- `dogfood-pass` for Flow Agents repo changes that should record evidence, critique, optional learning, state, and handoff in one validated pass

After writer updates, run `npm run workflow:validate-artifacts -- --require-sidecars .kontourai/flow-agents/<slug>` when local validation is available. If the writer or validation is unavailable or blocked by sandbox policy, record the exact gap in the session artifact as `NOT_VERIFIED` instead of pretending structured state exists.

`ensure-session` maintains `.kontourai/flow-agents/current.json`. The orchestrator is responsible for keeping root `state.json` and `handoff.json` current, but performs every such update **exclusively** through the sidecar writer (`npm run workflow:sidecar -- advance-state` for state transitions, `init-plan` for the initial plan write) — never through a direct Write/Edit tool call against the sidecar path. `config-protection.js` blocks direct tool-mediated writes to `state.json` by design; that block is expected and correct, not a bug to route around. Delegated agents must be given the workflow artifact root and should append events under `agents/<agent-id>/events.jsonl` through `record-agent-event` instead of guessing the slug or rewriting root state.

## Input

- **Goal**: what to build (from conversation context or explicit instruction)
- **Directory**: working directory
- **Selected work evidence**: existing `pull-work` and `pickup-probe` artifacts when the user is continuing provider-backed or productized backlog work

## TDD Mode

If the user requests test-driven development, activate the `tdd-workflow` skill instead. It wraps the same plan → execute → verify chain with test-first constraints and git checkpoints. deliver is for standard (implementation-first) workflows.

## Required Preflight

Before planning implementation, determine whether the request is direct ad hoc delivery or pickup of provider-backed/productized backlog work.

- If the user asks to pick up work, continue backlog work, build the next item, or deliver a selected issue, run or consume `pull-work` first. `pull-work` must enforce board selection, WIP/shepherding, dependency, grouping, and worktree logic.
- After `pull-work`, run or consume `pickup-probe` before `plan-work`. The pickup Probe must record selected item ids, scope, acceptance quality, provider state, WIP/conflict scan, dependency freshness, expected modified files, sandbox/worktree mode, decisions, unresolved questions, accepted gaps, and planning readiness.
- If current artifacts already prove `pull-work` and `pickup-probe` are fresh for the selected item or justified group, consume those artifacts and continue to `plan-work`.
- If the preflight is missing, stale, contradictory, or for a different selected item, stop before planning and route through `pull-work -> pickup-probe`; for pickup/planning gaps, route `decision_gap` back to `design-probe`.
- If the user gives a raw product idea instead of ready backlog work, suggest Builder Kit shape (`design-probe` + `idea-to-backlog`) rather than forcing delivery.

Direct ad hoc implementation requests that are not provider-backed backlog pickup may still start at `plan-work`, but `deliver` must record why pull/pickup preflight was not applicable.

## Session File

Path: `.kontourai/flow-agents/<slug>/<slug>--deliver.md`

```markdown
# <Goal one-liner>

branch: <branch>
worktree: <worktree>
created: <date>
status: planning | executing | reviewing | verifying | delivered
type: deliver
iteration: 0

## Workflow Rules (re-read at each phase transition)

- Reviewers and verifiers are REPORT ONLY — they never fix code
- Any code change requires re-review + re-verify before delivery
- Loop exits only when review + verify are both clean in same iteration
- Loop exits only after the Goal Fit Gate is fully checked or explicitly accepted
- CRITICAL/HIGH → re-plan → execute → review → verify
- MEDIUM/FAIL → execute fix pass → review → verify
- Temporary planning and execution artifacts live in `.kontourai/flow-agents/<slug>/`; durable feature documentation is promoted after CI/merge
- Local runtime work stays under `.kontourai/flow-agents/` and remains untracked; durable outcomes must be promoted before merge to `main`

## Plan

(populated by plan-work)

## Definition Of Done

(copied from plan-work; this is the user-facing stop condition)

## Execution Progress

(populated by execute-plan)

## Verification Report

(populated by verify-work)

## Goal Fit Gate

Use the Goal Fit Gate from `context/contracts/delivery-contract.md`.

## Final Acceptance

Use the Final Acceptance checklist from `context/contracts/delivery-contract.md`.

## History

- iteration 1: partial — auth routes done, form validation missing
- iteration 2: pass — all acceptance criteria met
```

`<branch>` is the branch recorded in `state.json`'s `branch` field (`ensure-session` derives `agent/<actor>/<slug>`; an explicit `--branch` flag overrides on a new session). `ensure-session` only records the name — creating and checking out the actual git branch/worktree remains this skill's responsibility.

The `status:` values in this Markdown session file are human-readable delivery progress labels. They are not the machine-readable `state.phase` enum; structured workflow sidecars must use the canonical lifecycle values from `context/contracts/artifact-contract.md`. In particular, review-work records critique through the critique artifact/sink while the sidecar lifecycle remains in a canonical phase such as `execution`, not a `review` phase.

## Workflow

### 1. Create session file

Create the session file with `status: planning`, `iteration: 0`. Use the sidecar writer when available:

```bash
npm run workflow:sidecar -- ensure-session \
  --source-request "<original request>" \
  --summary "<current delivery goal>" \
  --criterion "<acceptance criterion>" \
  --flow-id builder.build
```

`--flow-id builder.build` activates the FlowDefinition-driven path for this session. Producers fire, gates enforce on builder.* claims, and `advance-state` sets `active_step_id` automatically via the `builder.build` phase_map. Keep this flag on all `deliver`-initiated sessions; do not remove it for direct ad-hoc requests that are not builder-flow pickup.

### 2. Plan (plan-work)

Invoke plan-work with the goal, directory, session file path, and any pull-work / pickup-probe artifact refs. The plan must include `## Definition Of Done`. Present the plan to the user when a user decision is actually needed; otherwise record the plan artifact and continue automatically to execution.

This is a delegation gate. `plan-work` must delegate to `tool-planner` when that delegate is available, even if the environment is read-only or the repo cannot yet be modified. If the gate is blocked, preserve the attempted delegation/blocker in the session artifact and treat the delivery as `NOT_VERIFIED` or incomplete rather than substituting a local plan.

### 3. Execute (execute-plan)

Re-read the session file `## Workflow Rules` section before proceeding. Then invoke execute-plan with the plan artifact path and session file path.

### 4. Review (REPORT ONLY — review-work)

Invoke `review-work` with the session file path. Reviewers produce findings through the critique artifact/sink, currently `critique.json` locally. **They NEVER fix code.** No writes, no patches, no "found and fixed."

This is a delegation gate. `review-work` must delegate to `tool-code-reviewer` when that delegate is available. If security-sensitive files or behaviors are in scope, it must also delegate to `tool-security-reviewer`. Architecture and standards concerns are part of the code review scope unless the project configures a more specific reviewer.

### 5. Verify (REPORT ONLY — verify-work)

Invoke verify-work with the session file path. Verifiers run checks and report status, including acceptance criteria and Goal Fit. **They NEVER fix code.** No format fixes, no lint auto-fixes, no patches.

This is a delegation gate. `verify-work` must delegate to `tool-verifier` when that delegate is available. If UI or browser-facing behavior is in scope, delegate that evidence collection to `tool-playwright` as well. If the gate is blocked, report the exact `NOT_VERIFIED` evidence gap; do not replace verification with an orchestrator-only summary.

### 6. Route on findings

Combine the critique artifact/sink verdict + verification verdict:

- **Clean** (no issues, all PASS) → deliver
- **Goal Fit Gate incomplete** → fix pass or final acceptance decision
- **CRITICAL or HIGH review findings** → re-plan (step 7a)
- **MEDIUM review findings needing code changes** → fix pass (step 7b)
- **Any verification FAIL** → fix pass (step 7b)
- **Any NOT_VERIFIED** → surface to user, they decide

When the route is deterministic, continue without asking the user between stages. Use the local stop/steering hooks when available to resume automatically after phase transitions. Ask the user only for explicit approval, missing authority, unsafe escalation, accepted gaps, unresolved `NOT_VERIFIED`, provider decisions, or scope changes.

### 7. Loop (mandatory re-verify)

**Any code change requires a subsequent clean review + verify pass. No exceptions.**

#### 7a. Re-plan (CRITICAL/HIGH issues)

1. Increment `iteration` in session file
2. Re-invoke plan-work with: original goal + failure summary → updated plan
3. Back to step 3 (Execute) → then step 4 (Review) → step 5 (Verify)

#### 7b. Fix pass (MEDIUM issues / verification failures)

1. Increment `iteration` in session file
2. Back to step 3 (Execute) with the specific findings to fix
3. Then step 4 (Review) → step 5 (Verify)

**The loop exits ONLY when review + verify both produce zero findings, all PASS in the same iteration, and Goal Fit Gate is complete.** Not when fixes are applied — when fixes are *verified clean and useful to the user*.

### 8. Goal Fit Gate

Before final response, update `## Goal Fit Gate` in the session file. If any box is unchecked, either keep working or surface the exact decision needed. Do not hide open gaps in a summary.

Record the final local state with `advance-state`. Use `status: verified` only when verification and critique are clean; use `status: needs_decision`, `failed`, or `not_verified` for unresolved gaps.

### 9. Publish Verified Change

After review, verification, evidence, and Goal Fit are clean for the same diff:

1. Confirm the working tree contains only verified scope.
2. Publish the session trust bundle so the CI trust-reconcile job can verify what the agent claimed. `record-release` (via the sidecar writer) does this automatically (best-effort). To publish or re-publish explicitly:

   ```bash
   npm run workflow:sidecar -- publish-delivery .kontourai/flow-agents/<slug>
   ```

   **#356 — local reconcile-shape preflight.** `publish-delivery`/`record-release` now run a
   local, pre-push **reconcile-shape preflight** on the session's `trust.bundle` before
   copying anything into `delivery/`. It reuses the exact same claim-shape classification
   `scripts/ci/trust-reconcile.js` enforces in CI (`scripts/lib/reconcile-shape.js`), so it
   can never silently drift from what the required Trust Reconcile check actually does. If
   the bundle is ADR-0020-invalid (e.g. a command-backed claim whose command isn't in the
   reconcile manifest, an unwaived `assumed` claim, or an un-superseded disputed critique),
   publish is **refused, fail-closed** — non-zero exit, a loud `REFUSING to publish` message
   naming each invalid claim and its fix, and nothing is written to `delivery/`. This is
   distinct from the existing fail-**soft** behavior when no `trust.bundle` exists yet at all
   (still a silent no-op). When refused: fix the named claim (re-record evidence, add a
   missing waiver, or supersede the disputed critique), then retry — do not attempt to push
   past the refusal. You can also run the same check manually, any time before publish, to
   catch a shape issue locally instead of discovering it minutes later in CI:

   ```bash
   npm run workflow:sidecar -- reconcile-preflight .kontourai/flow-agents/<slug>
   ```

   **#381 — manifest-lane constraint: which commands may be `kind:"command"` checks.** A check/claim
   is only CI-reconcilable as `kind:"command"` (Surface's `test_output` evidence type) if its
   command is a registered entry in the **trust-reconcile manifest** — the same
   `{"id":..,"command":..,"lanes":[..]}` list `evals/ci/run-baseline.sh --manifest-json` emits
   from its `CHECKS` array (source of truth: `evals/ci/run-baseline.sh` lines 12-67 for the
   array, 166-182 for `emit_manifest_json`). `scripts/ci/trust-reconcile.js` resolves this same
   manifest (`resolveManifest`/`manifestByCmd`, lines 292-370, 1101-1104) and reconciles a
   `kind:"command"` claim's `execution.label` ONLY against it — a command not in the manifest
   can never reconcile, and CI's reconciler names it exactly this way: `trust divergence: agent
   claimed '<cmd>' passed; command is not in the reconcile manifest — a test_output claim must
   name a manifest/required-lane command (CI cannot self-declare an arbitrary command)`. An
   honest capture-backed check recorded against a real, passing, non-manifest command still
   becomes this `not-run` divergence at CI reconcile time — it is not a shape bug to route
   around, it is the manifest boundary working as designed. Anything that is not a registered
   manifest command records as `kind:"external"` (a session-local attestation — e.g. a manual
   code-review judgment) or `kind:"policy"` (a policy/compliance attestation — e.g. `promote`'s
   claim, which carries no `command`/`execution.label` and therefore can never require a
   manifest entry). This matters at every writer call that can produce a `kind:"command"`
   check — `record-evidence`, `record-gate-claim --command`, and `record-check` — and again at
   the `publish-delivery`/`reconcile-preflight` step above, which is where a non-manifest
   command surfaces as a refusal before CI ever sees it. Gate claims recorded earlier in a
   session are not special-cased here: the compose-safe writer path keeps every prior gate
   claim's declared claim type intact across later `record-evidence`/`record-critique`/
   `record-learning` calls, so a gate claim never needs to be the last write of a session to
   survive.

   - `kind:"command"` (manifest-backed) example — a real, currently-registered manifest entry
     ("Source tree validation" → `npm run validate:source --`):

     ```bash
     npm run workflow:sidecar -- record-check .kontourai/flow-agents/<slug> -- npm run validate:source --
     ```

   - `kind:"external"` (non-manifest attestation) example — no `--command`, so nothing is
     ever executed; the prose lives in `--summary`:

     ```bash
     npm run workflow:sidecar -- record-gate-claim .kontourai/flow-agents/<slug> \
       --status pass \
       --summary "Manual code review confirmed no regressions in the affected module."
     ```

   **#379 — per-session delivery paths.** `publishDelivery()` writes to a PER-SESSION path
   `delivery/<slug>/trust.bundle` (+ `trust.checkpoint.json` companions), where `<slug>` is
   your session artifact dir's basename — NOT the old shared flat `delivery/trust.bundle`.
   This is deliberate: a shared path guaranteed a git merge conflict between ANY two
   concurrent deliveries, and a conflicting PR gets no CI (see the loud callout below). The
   CI reconciler discovers both the flat (back-compat) and per-session layouts and selects
   the NEWEST candidate whose checkpoint attests THIS change by commit ancestry — so an older
   inherited bundle that also happens to be an ancestor of your change is ignored in favour of
   your fresh one, and stale siblings from other sessions are ignored. `publishDelivery()`
   also prunes inherited per-session sibling seal dirs (unique-named, never a cross-PR
   conflict) so `delivery/` stays small; it deliberately does NOT delete the shared flat
   `delivery/trust.bundle` legacy path (a concurrent PR may still seal there, and deleting it
   would cause the DIRTY→no-CI conflict in the callout below).

   Then force-stage the per-session trust dir for the delivery commit. It is gitignored by
   default (runtime artifacts written on every local delivery) — `-f` commits it
   deliberately into THIS delivery PR so CI's trust-reconcile job can reconcile the
   session's claims against fresh CI results:

   ```bash
   git add -f delivery/<slug>/
   ```

   (If `publishDelivery()` pruned a superseded per-session SIBLING dir, stage that deletion
   too — `git add -A delivery/` after the force-add. Do NOT hand-delete the flat
   `delivery/trust.bundle` in a delivery PR while other PRs may still seal to it.)

   **#293 — verify-hold gate. HARD STOP.** Before committing/pushing/opening a PR/merging,
   run the verify-hold check (it also runs automatically inside `publish-delivery` /
   `record-release` / `advance-state --status delivered`, but run it explicitly here BEFORE
   committing/pushing, since by the time `record-release` runs the branch may already be
   pushed). **The command differs by this repo's configured assignment provider kind — a bare
   `verify-hold <slug>` with no provider flag always defaults to `--assignment-provider
   local-file` (`runVerifyHold`'s documented default), so on a `github`-provider repo it reads
   no local claim record and silently resolves `free`/PASS regardless of the real GitHub hold
   state. The local-file-only invocation below is NOT sufficient for a `github`-provider repo —
   the github branch is MANDATORY for that provider kind:**

   - **local-file provider** (this repo's configured assignment provider, from
     `effective-assignment-provider-settings`, is `local-file`):

     ```bash
     npm run workflow:sidecar -- verify-hold .kontourai/flow-agents/<slug>
     ```

   - **github provider**: render-then-execute, mirroring `pull-work`'s SKILL.md claim-side
     pattern for the same ADR 0021 §1 join — first read the effective state (no live `gh` call
     happens inside `workflow-sidecar.ts`; the skill renders it here), then pass the rendered
     `.effective` JSON into `verify-hold` via `--effective-state-json`:

     ```bash
     gh issue view <issue-number> --json assignees,labels,comments > /tmp/issue.json
     npm run assignment-provider -- status \
       --provider github \
       --subject-id <slug> \
       --issue-json /tmp/issue.json \
       --liveness-stream <path-to-events.jsonl> \
       --self-actor <actor> \
       > /tmp/assignment-status.json
     npm run workflow:sidecar -- verify-hold .kontourai/flow-agents/<slug> \
       --assignment-provider github \
       --effective-state-json /tmp/assignment-status.json
     ```

     (`/tmp/assignment-status.json`'s top-level shape is `{ role, provider, assignment,
     effective }`; `verify-hold --effective-state-json` reads the `.effective` field, matching
     `assignment-provider status`'s own output shape directly — no reshaping needed.)

   This is the ONE point in the whole workflow that BLOCKS instead of warns (ADR 0021 §3). It
   asks exactly one question: is this actor still the fresh, non-superseded holder of this
   subject (or is the subject free/self-held)? **If the check reports not-fresh-holder (exit
   non-zero, `ok:false` in the JSON result): DO NOT commit, push, open a PR, or merge.** This
   is a different failure mode from the `publish-delivery`/reconcile-shape preflight paragraph
   above — that one is about the trust *bundle's shape* being invalid; this one is about
   *actor hold* — another actor holds a fresh claim on this subject, your own claim has gone
   stale, or the subject is assigned to a human. Do not conflate the two "REFUSING to publish"
   messages. When refused, follow the reconcile guidance (the CLI's own `guidance` field, or
   verbatim): re-run `pull-work`/`pickup-probe` to discover the current holder and hand off
   cleanly (`learning-review`/handoff), or, if a human confirms this session should resume
   ownership, run `ensure-session --supersede-stale` before retrying.

3. Commit the verified diff, including the force-added `delivery/<slug>/` trust artifacts.
4. Push the branch.

   > **⚠ LOUD FAILURE MODE — a DIRTY PR gets NO CI, silently (#335/#379).** If `main` moves
   > under your open PR and produces a merge conflict, GitHub marks the PR `DIRTY` and
   > **schedules NO `pull_request` workflows for it** — zero checks, no error, nothing. The
   > required **Trust Reconcile** gate then silently never runs, and the PR sits unbuildable
   > looking like "CI vanished" rather than "conflict." Per-session delivery paths (#379)
   > remove the STRUCTURAL cause for delivery-artifact conflicts (concurrent seals no longer
   > share a file), but ANY other same-file conflict with `main` can still trigger it.
   > **Diagnose it explicitly — do not assume a missing required check means "not run yet":**
   >
   > ```bash
   > gh pr view <pr> --json mergeStateStatus,mergeable,statusCheckRollup
   > ```
   >
   > `mergeStateStatus: DIRTY` (or `CONFLICTING`) with an ABSENT Trust Reconcile check is the
   > signature. Fix by rebasing/merging `main` to clear the conflict and re-pushing — that
   > re-triggers the `pull_request` workflows. A green-looking PR with the required gate simply
   > MISSING is not "pending"; it is this failure mode until proven otherwise.
5. Open or update the provider change record with issue links, closing refs, evidence links, and verification summary, or record an explicit no-provider-change reason.
6. Wait for provider checks/CI or record missing checks as `NOT_VERIFIED`.
7. Record the gate claim for the Builder Kit `pr-open` step immediately after the PR is opened or updated:

```bash
npm run workflow:sidecar -- record-gate-claim .kontourai/flow-agents/<slug> \
  --expectation pull-request-opened \
  --status pass \
  --summary "PR opened: <pr-url>. Linked to <work-item-ref>, implementation summary and verification evidence attached." \
  --evidence-ref-json '{"kind":"provider","url":"<pr-url>"}'
```

Use `--status fail` when the PR cannot be opened or when no provider change record is created and the reason is not an accepted no-provider-change path. Use `--status not_verified` when provider access is unavailable and the PR creation cannot be confirmed.

Do not invoke `release-readiness` before this gate unless the user explicitly accepts a no-provider-change/no-push path and the reason is recorded in the session artifact. For GitHub, the first `ChangeProvider` adapter example is a PR with PR checks.

### 10. Final Acceptance And Docs Promotion

After CI passes and the work is merged or otherwise accepted:

1. Update `## Final Acceptance` in the session file.
2. Archive the working artifacts under `.kontourai/flow-agents/<slug>/archive/` or keep a stable link to them.
3. Record provider records, verification evidence, durable docs targets, accepted gaps, and follow-up routing in durable docs or provider records.
4. Promote the relevant plan, decision, evidence, and usage notes into long-lived docs such as `docs/`, `README.md`, or a project decision record.

   **Assisted promotion path (Knowledge Kit `knowledge.promote` sub-flow).** Rather than
   deciding WHAT to promote by ad-hoc judgement, run the Knowledge Kit promote sub-flow
   (`kits/knowledge/flows/promote.flow.json`, id `knowledge.promote`) over the session
   directory. It ingests the session's plan/evidence/critique/learnings/transcripts,
   distills schema-valid DRAFT decision-registry deltas (per
   `context/contracts/decision-registry-contract.md`), CONTEXT.md vocabulary additions,
   and learning entries, links each to the PR + merge SHA + session archive + touched
   topics, and health-checks the registry for contradictions (proposing merge-repair).
   It is PROPOSALS-ONLY: every output lands under `<session>/proposals/` — it never writes
   docs directly. You apply the drafts you accept, then record what was promoted where with
   the `promote` CLI (below), which stays the recording mechanism. The sub-flow is the
   assisted path; the `promote` claim is the gate. `knowledge.promote` is a true composable
   FlowDefinition (a parent step can `uses_flow: "knowledge.promote"`); it is invoked here
   from the promote step rather than nested as a builder gate because the `promote` CLI —
   not a flow gate — is #312's recording mechanism and the sub-flow's outputs are proposals
   a human/agent applies.
5. Link the long-lived doc back to the provider record, archived plan artifact, or accepted evidence when useful so future readers can see why and how the feature was built.
6. Confirm `.kontourai/flow-agents/` runtime artifacts remain untracked before merge to `main`.
7. **Clean up the workspace once the merge is confirmed.** First verify the merge actually happened from the provider's own record (a merge commit / `mergedAt`) — not a green check or a watcher's exit code. Then honor the `worktree_lifecycle` recorded by `pull-work` (`retain_until: pr_merged`): remove the isolated worktree (`git worktree remove <path>`) and delete the now-merged branch locally and on the remote. Never delete a branch or worktree before the merge is confirmed — a closed-but-unmerged PR or a prematurely deleted branch loses work. The task is not done while it leaves a stale worktree or merged branch behind.
8. Hand off to `learning-review` for terminal closeout. Clean runs record a lightweight no-correction-needed learning record (`correction.needed: false`, closed routing such as `target: "none"`); mismatches, friction, missing docs, failed gates, incidents, or product follow-up record `correction.needed: true` or `FOLLOWUP_REQUIRED` with routed prevention/follow-up. Do not skip learning just because the delivery looked clean.

### 11. Deliver

1. Include the verification report verbatim in your delivery message
2. `git diff --stat`
3. Summarize: what was built, iterations taken, issues resolved, Goal Fit status, and final acceptance/docs status
4. Set `status: delivered`

{context?}
