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

## Orchestrator Rule

You never use `read`, `glob`, `grep`, or `code` on source files. You only read/write the session file and artifact files in `.kontourai/flow-agents/<slug>/`.

## Shared Contracts

Follow:
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

`ensure-session` maintains `.kontourai/flow-agents/current.json`. The orchestrator owns root `state.json` and `handoff.json` updates. Delegated agents must be given the workflow artifact root and should append events under `agents/<agent-id>/events.jsonl` through `record-agent-event` instead of guessing the slug or rewriting root state.

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
2. Publish the session trust bundle to `delivery/` so the CI trust-reconcile job can verify what the agent claimed. `record-release` (via the sidecar writer) does this automatically (best-effort). To publish or re-publish explicitly:

   ```bash
   npm run workflow:sidecar -- publish-delivery .kontourai/flow-agents/<slug>
   ```

   Then force-stage the trust artifacts for the delivery commit. They are gitignored
   by default (they are runtime artifacts written on every local delivery) — `-f`
   commits them deliberately into THIS delivery PR so CI's trust-reconcile job can
   reconcile the session's claims against fresh CI results:

   ```bash
   git add -f delivery/trust.bundle delivery/trust.checkpoint.json
   ```

3. Commit the verified diff, including the force-added `delivery/trust.bundle` and `delivery/trust.checkpoint.json`.
4. Push the branch.
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
