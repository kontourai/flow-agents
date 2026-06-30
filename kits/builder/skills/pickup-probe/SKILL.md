---
name: "pickup-probe"
description: "Builder Kit work-item/docs/provider-grounded Probe specialization used at the design-probe flow step before plan-work."
---

# Pickup Probe

Probe selected backlog work before Builder Kit planning starts.

## Contract

`pickup-probe` is the Builder Kit pickup specialization of the `design-probe` flow step. It runs after `pull-work` selects work and before `plan-work` creates an execution plan.

Direct `pull-work` and direct `plan-work` remain valid standalone primitives. This skill is required when the productized Builder Kit `build` flow has selected work, when a user asks to pick up work and continue into build/delivery, or when `deliver` needs to prove selected-work readiness before planning.

This skill is modeled after Matt Pocock's `grill-with-docs`: challenge the selected work against the existing domain model, sharpen terminology, cross-check docs and code, ask one recommended question at a time, update durable glossary terms inline when they crystallize, and offer ADRs only for hard-to-reverse, surprising, trade-off decisions.

## Required Inputs

- Selected work item or coherent work item group.
- Pull-work artifact with board snapshot, WIP assessment, selection rationale, scope, non-goals, pickup gate, and handoff.
- Provider state, including WorkItemProvider and BoardProvider refs, issue status, labels, milestone/project fields, blockers, PR links, and source artifact refs when available.
- WIP and conflict scan covering active sessions, open PRs, verification/review/CI remediation queues, expected shared files, and worktree or sandbox mode.
- Existing acceptance criteria, done criteria, stop-short risks, and known non-goals.
- Source issue and artifact refs, including issue URLs, source planning or idea artifacts, flow definition refs, and missing-source notes.
- Repository reality: `CONTEXT.md` when present, relevant docs, ADRs, contracts, skills, schemas, fixtures, and code paths named by the selected work.
- Domain documentation: root `CONTEXT.md`, `CONTEXT-MAP.md` when present, and relevant `docs/adr/` records. If no durable context file exists, create one lazily only when a resolved project-specific term needs a home.
- Planned-base drift context: `planned_base_ref`, `planned_base_sha`, current target ref/SHA, `planning_scope_refs`, and a diff summary from the planned/pulled work SHA to current HEAD when available.

If a required input is missing, first try to recover it from local artifacts and provider snapshots. Ask one alignment question only when the missing input creates a real decision gap that cannot be resolved from local evidence.

If `planned_base_sha` is missing, record that as a `NOT_VERIFIED` drift baseline gap and use current target plus provider history as the best available baseline. Do not invent a planned SHA.

For Builder Kit baseline freshness gaps where `planned_base_sha` is missing or inconclusive, record `resolution_hints` in the Builder Kit Probe record when that record shape is available. Use `gap_id: revision_freshness_not_verified`, `claim_id: planning.baseline.current`, and a reason code such as `missing_planned_base_sha`. The hint should name the blocked refs, the required evidence needed to resolve the gap, `resolve_at` pointing back to `pickup-probe`, and any explicit accepted fallback baseline that allows planning to continue.

## Behavior

Challenge the selected work against the repository before planning:

- Fetch latest for the target ref when available, then compare the current target SHA to `planned_base_sha`. Record current target ref/SHA, planned base ref/SHA, `commits-since`, planned age, changed files reviewed, and changed-file intersections with `planning_scope_refs`.
- Classify revision freshness as `fresh`, `drifted`, or `stale`. `fresh` may proceed through normal pickup gates. `drifted` prompts alignment and may proceed only when the Probe records accepted decisions or an explicit accepted gap. `stale` routes back to `idea-to-backlog` before implementation planning.
- If `planned_base_sha` is missing, mark the freshness check `NOT_VERIFIED` and record the concrete fallback baseline, such as current target ref/SHA plus provider history. Treat that as an accepted gap only when the artifact names why planning may continue; do not invent a planned SHA. When using a Builder Kit Probe JSON record, include `resolution_hints` for `revision_freshness_not_verified` so the next planning attempt can see the accepted fallback baseline or route back to `pickup-probe` for missing evidence.
- Research drift before asking questions: compare the selected work's `planned_base_sha` or pulled-work SHA to current HEAD before running the alignment interview. Inspect changed files, docs, ADRs, contracts, schemas, dependency state, and expected execution areas that overlap `planning_scope_refs` or likely modified files.
- Classify the diff from planned base to current HEAD as `no_material_drift`, `scope_drift`, `dependency_drift`, `contract_drift`, or `conflict_risk`. Treat material drift as pickup Probe context and ask an alignment question before planning when it changes scope, acceptance criteria, dependency assumptions, terminology, contract expectations, or execution risk.
- Compare the selected work to `CONTEXT.md`, docs, ADRs, contracts, existing skills, schemas, fixtures, and nearby code.
- Verify that the acceptance criteria describe an executable outcome rather than only implementation tasks.
- Sharpen fuzzy domain and workflow terms until the artifact names, scope, gate names, and next step mean one thing.
- Surface contradictions between issue text, pull-work handoff, provider state, docs, ADRs, contracts, and code reality.
- Challenge glossary conflicts immediately: if a user or issue uses a term differently than `CONTEXT.md`, ask which meaning is authoritative before planning.
- Discuss concrete scenarios when boundaries are fuzzy, especially around ownership, provider state, workflow gates, and stop-short behavior.
- Check whether the selected work is still ready after WIP, conflicts, blockers, dependency freshness, and expected modified files are considered.
- Keep downstream issues and non-goals out of scope unless they are explicit contract consumers for the selected work.
- Ask one question at a time when a decision is needed, include a recommended answer, and record the answer immediately.
- Record unresolved questions as blockers unless the user or orchestrator explicitly accepts proceeding with the gap.
- Update the active workflow artifact immediately when a decision crystallizes; do not rely on chat memory.

For Builder Kit build-flow recovery, a missing or incomplete pickup Probe record routes `decision_gap` back to the `design-probe` step. For pickup/planning gaps, returning to `design-probe` means completing this pickup Probe record before retrying `plan-work`.

## Output

Record the pickup Probe result in the pull-work artifact, handoff artifact, or documented Builder Kit Probe record referenced by `state.json` or `handoff.json`. The record must include:

- Probe status: `pass`, `needs_decision`, `blocked`, or `accepted_gap`.
- Decisions made during the Probe, with source refs when relevant.
- Unresolved questions, each with owner, impact, and whether it blocks planning.
- Accepted gaps, including who accepted the gap and why planning may continue.
- Drift research: planned base ref/SHA, current target ref/SHA, command or provider evidence used, changed files reviewed, drift classification, and whether the drift is material.
- Builder Kit `resolution_hints` when available for baseline freshness `NOT_VERIFIED` gaps, including `planning.baseline.current`, required baseline evidence, and the accepted fallback baseline behavior.
- Planning readiness: ready/not ready, required handoff target, and readiness evidence.
- Expected modified files or file areas, including generated/runtime artifact expectations when relevant.
- Conflict risks with active work, shared files, provider state, or downstream contract consumers.
- Route reason and next action, such as `continue -> plan-work`, `decision_gap -> design-probe`, `blocked -> pull-work`, or `split_scope -> pull-work`.

## Planning Gate

Planning is ready only when:

- Selected work and source refs are clear enough for `plan-work`.
- Acceptance criteria and done criteria are present or explicit accepted gaps exist.
- Planned-base drift research is recorded, or the missing baseline is explicitly marked `NOT_VERIFIED` with a best-available fallback.
- Provider state and WIP/conflict scan have been checked or marked `NOT_VERIFIED` with a reason.
- Scope, non-goals, expected modified files, and conflict risks are recorded.
- Contradictions are resolved, blocked, or explicitly accepted as gaps.
- The route reason and next action are recorded in an artifact that can be recovered without chat memory.

If the gate fails, stop before `plan-work` and update the artifact with the blocker or decision gap.
## Gate Claims: Record Pickup Probe Results

When the Planning Gate passes, record the two gate claims for the Builder Kit `design-probe` step before handing off to `plan-work`. These satisfy the `builder.design-probe.pickup-readiness` and `builder.design-probe.decisions` gate expectations.

**Claim 1 — Pickup readiness** (probe passed, goal fit and scope confirmed):

```bash
npm run workflow:sidecar -- record-gate-claim .kontourai/flow-agents/<slug> \
  --expectation pickup-probe-readiness \
  --status pass \
  --summary "Pickup probe passed: goal fit confirmed, blockers checked, dependencies reviewed, acceptance criteria verified." \
  --evidence-ref-json '{"kind":"artifact","file":".kontourai/flow-agents/<slug>/<slug>--pull-work.md","summary":"Pull-work artifact recording probe status, scope, and planning readiness."}'
```

**Claim 2 — Probe decisions captured** (decisions, accepted gaps, and planning readiness are recorded):

```bash
npm run workflow:sidecar -- record-gate-claim .kontourai/flow-agents/<slug> \
  --expectation probe-decisions-or-accepted-gaps \
  --status pass \
  --summary "Probe decisions recorded: <decision-count> decisions, <gap-count> accepted gaps. Planning readiness: <ready|accepted_gap_ready>." \
  --evidence-ref-json '{"kind":"artifact","file":".kontourai/flow-agents/<slug>/<slug>--pull-work.md","summary":"Pull-work artifact with decisions, accepted gaps, and planning handoff."}'
```

Record both claims together immediately when the gate passes. Use `--status fail` when the gate fails (unresolved blocker or decision gap). Use `--status not_verified` only when the session has no active flow step.

When the gate fails, record `--status fail` with `--expectation pickup-probe-readiness` naming the blocker, and omit or defer the decisions claim until the blocker is resolved.



## Docs And ADR Policy

`pickup-probe` may identify durable terminology and decision gaps, but it must keep documentation changes narrow:

- Update `CONTEXT.md` inline only for glossary-style durable terminology decisions, using tight one- or two-sentence definitions and `_Avoid_` terms when useful. Keep implementation details out of `CONTEXT.md`.
- If a `CONTEXT-MAP.md` exists, update the relevant context instead of assuming the root glossary owns the term.
- Create a lazy context file only when a resolved term or workflow concept has no existing home.
- Do not create context files for transient planning notes, open questions, or provider snapshots.
- Propose or create ADRs sparingly, only when all three are true: the decision is hard to reverse, surprising without context, and the result of a real trade-off.
- Prefer workflow artifacts for pickup decisions, unresolved questions, accepted gaps, and route reasons until the work is accepted.

## Handoff To Plan Work

When the Probe passes, hand off to `plan-work` with:

- selected work item refs
- pull-work artifact path
- pickup Probe record path or section
- provider state summary
- planned-base drift summary and drift classification
- accepted gaps
- expected modified files
- conflict risks
- sandbox/worktree mode
- route reason and next action

`plan-work` must consume this record for Builder Kit build-flow planning. If the record is absent, contradictory, or lacks an accepted gap for a known decision gap, planning stops and routes back to `design-probe`.
