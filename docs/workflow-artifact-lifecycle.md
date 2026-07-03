---
title: Workflow Artifact Lifecycle
---

# Workflow Artifact Lifecycle

Flow Agents treats task artifacts as useful working memory, not permanent product documentation. Feature branches should promote durable planning, decisions, evidence pointers, and acceptance notes into normal project docs, source, schemas, or provider records instead of carrying `.kontourai/flow-agents/` runtime files.

The local artifact root is a current-state dashboard first and a short-lived recovery cache second. It should answer "what needs attention now?" without forcing agents to sift through old successful deliveries.

## Audit Command

Use the read-only cleanup audit before making any local retention decision:

```bash
npm run workflow-artifact-cleanup-audit -- --artifact-root .flow-agents
npm run workflow-artifact-cleanup-audit -- --artifact-root .flow-agents --json
```

The default root for local runtime artifacts is `.kontourai/flow-agents`. `.flow-agents` may hold explicit durable Flow Agents config/install state, but it is not a runtime fallback. Move old local sessions with the migration script instead of relying on automatic fallback reads.

The command scans immediate workflow directories, skips non-workflow lanes such as `archive/`, and reports active WIP separately from cleanup candidates, terminal done records, active learning follow-ups, and invalid sidecars. This first slice is dry-run classification only: it does not delete, archive, move, or rewrite runtime artifacts by default, and it has no apply mode.

Use the Current-State Semantics and Local Retention Policy sections below to interpret each bucket. In particular, learning records with `learning.status: followup_required` or any `routing[].status: open` remain active learning follow-ups until every route is completed, opened elsewhere, deferred with a trigger, accepted, or rejected.

## Artifact Lanes

Use one local non-durable lane under `.kontourai/flow-agents/`:

| Lane | Path | Commit Policy | Purpose |
| --- | --- | --- | --- |
| Runtime workspace | `.kontourai/flow-agents/<slug>/` | Do not commit | Local session state, sidecars, delegate events, scratch evidence, and recovery notes. |

The runtime workspace stays local because it may contain stale session state, machine-specific paths, or noisy intermediate artifacts. When a branch needs cross-session or cross-person traceability, promote the durable summary, decisions, evidence pointers, and acceptance notes into docs, source, schemas, or provider records instead of committing runtime artifacts.

## Current-State Semantics

Treat `state.json` as the active-work signal for local users and `pull-work`.

| State shape | Meaning | Queue treatment |
| --- | --- | --- |
| `planning`, `planned`, `in_progress`, `verifying`, `blocked`, `failed`, `not_verified`, or `needs_decision` | Work still needs agent or user attention. | Active WIP or shepherding candidate. |
| `verified` with `next_action.status: continue` | Local evidence passed, but release, final acceptance, or learning is not closed. | Active shepherding candidate. |
| `verified` with `next_action.status: done` | Evidence passed and the next phase was completed outside the state machine or by a provider record. | Cleanup candidate; should be advanced to a terminal state during final acceptance. |
| `accepted` with `phase: learning` and `learning.status: followup_required` | Learning was captured but at least one routed follow-up is still open or undecided. | Active learning follow-up until routed to backlog, docs, evals, skills, knowledge, or an explicit deferred trigger. |
| `delivered`, `accepted`, or `archived` with `phase: done`, or `accepted`/`archived` with closed learning routing | Completed local workflow. | Terminal only once a promotion claim is recorded (see [Promote-Then-Archive Gate](#promote-then-archive-gate)); a delivered/accepted session with no promotion claim is a cleanup candidate, not terminal. Retain only while useful for recovery or audit. |

`verified` is not a terminal state. It means the verifier supplied evidence. Final acceptance must still record the provider change, CI/release result, docs promotion decision, and any learning route before the workflow stops being active.

## Promote-Then-Archive Gate

Archiving a delivered session is not a parallel chore to promoting its durable
residue — it is **gated on** it. The sequence is:

```
final acceptance  ->  promote  ->  archive
```

Durable-residue extraction is the archival act. A delivered session's decisions,
vocabulary, learnings, and doc updates must be promoted into durable living docs
(`docs/decisions/<slug>.md`, `CONTEXT.md`, `docs/learnings/*`, `README.md`,
`context/contracts/`, schemas, provider records) before the session is retired,
so no delivered work is retired without its knowledge extracted.

### The promotion claim

The `promote` step records **what was promoted where** and writes a **promotion
claim** into the session `trust.bundle`:

```bash
# Real durable residue: each --evidence-path must exist on disk at record time.
flow-agents workflow-sidecar promote <session-dir> \
  --evidence-path docs/decisions/<slug>.md \
  --evidence-path CONTEXT.md
```

The claim is **session-local by construction** (check kind `policy` ->
`policy_rule` evidence, no command / `execution.label`). It therefore needs **no
new reconcile-manifest entry** and can **never** become a `[not-run]` /
unbacked-command divergence at CI `trust-reconcile`: the reconciler classifies it
session-local and accepts it as an ATTESTED claim. The durable doc paths are the
claim's evidence refs; each is verified to exist on disk when the claim is
recorded (a missing path fails loud), and they are mirrored into an auditable
`promotion.json` in the session directory. The claim is detectable by the archive
gate and validators via `claim.metadata.promotion` without any manifest change.

### Empty-promotion path

When a delivered session genuinely produced **no durable residue** (e.g. a pure
refactor with no decision, vocabulary, or doc change), record an explicit,
auditable no-residue promotion rather than skipping the gate:

```bash
flow-agents workflow-sidecar promote <session-dir> \
  --none --reason "<why nothing durable was promoted>"
```

This still produces a promotion claim (with `none: true` and the reason), so the
decision that nothing needed promoting is recorded, not silently assumed.

### Archive enforcement

`workflow-artifact-cleanup-audit` classifies a **delivered or accepted** session
that reached a terminal shape **without** a promotion claim as a
`cleanup_candidate` (blocked from archive) with a reason naming the `promote`
remedy — not `terminal_done`. With the claim (real residue **or** `--none`) it
classifies `terminal_done` and may be archived. Already-`archived` sessions are
past the gate and are never re-flagged; this gate is not a backfill of historical
archives.

## Learning Closeout

Learning records are a routing surface, not a permanent parking lot.

Use `learning.status: followup_required` only while at least one learning route still needs action. Each route should end in one of these outcomes:

- `completed`: the doc, eval, skill, backlog item, code change, or knowledge update was made.
- `open`: a provider-backed issue, backlog artifact, or named owner now tracks the follow-up.
- `deferred`: the follow-up has a concrete revisit trigger, such as a later milestone, repeated failure pattern, provider capability, or date.
- `rejected`: the follow-up was considered and intentionally not pursued, with a reason in the learning record.

Once every route is completed, open elsewhere, deferred with a trigger, or rejected with a reason, record `learning.status: learned` and advance the workflow out of active WIP. Do not leave local runtime state as `needs_decision` only because a durable follow-up issue exists.

Terminal learning review also records correction state in `learning.json`. Before closeout, compare intended behavior to observed behavior:

- Clean runs use `correction.needed: false`, brief `correction.evidence`, and closed/no-follow-up routing such as `target: "none"` with `status: "completed"`.
- Mismatches use `correction.needed: true` with typed `correction.type`, stable `correction.recurrence_key`, intended behavior, observed behavior, gap, and a prevention route or explicit `no_change_rationale`.

Correction records stay in local `learning.json` for this slice. They do not create a new sidecar, do not upload to Source/Sink storage, do not build Console/dashboard UI, and do not automatically open provider issues. Future consumers can derive correction rate, resolved corrections, repeated recurrence keys, stale unresolved corrections, and clean-run rate from the same fields.

Durable learning should be promoted by target:

- workflow rule changes go to `context/contracts/`, `skills/`, or workflow docs
- regression expectations go to `evals/`
- product or architecture decisions go to `docs/` or `docs/adr/`
- executable work goes to GitHub issues or the configured backlog provider
- durable user/team memory goes to the configured knowledge store

## Local Retention Policy

For local-only users, keep enough local state to recover recent work, but do not use `.kontourai/flow-agents/<slug>/` as the long-term system of record.

Recommended defaults:

| Artifact class | Retain locally | Durable destination |
| --- | --- | --- |
| Active WIP, blockers, and unresolved decisions | Until resolved | Current `.kontourai/flow-agents/<slug>/` state and handoff. |
| Recently merged or accepted deliveries | 14-30 days, or until the next queue audit | PR body, issue comments, release records, promoted docs, or archived evidence refs. |
| Security, migration, release, or provider-governance evidence | 30-90 days when useful for audit | Provider record, release note, durable doc, or external evidence store. |
| Routine successful local runtime artifacts | Delete or archive after durable promotion and recovery window | Usually none beyond provider record and docs. |
| Learning records with routed follow-ups | Until all routes are completed, opened elsewhere, deferred with trigger, or rejected | Backlog issue, docs/evals/skills change, or knowledge note. |

When a future Source/Sink service is available, the same lifecycle should apply: local runtime artifacts become a cache and upload source; the service becomes the searchable history. Local-only users should still be able to run cleanup from provider records and durable docs without losing active work.

## Prevention Rules

To prevent historical entries from polluting current-state scans:

1. After a PR is merged or a no-provider-change path is accepted, final acceptance must advance `state.json` out of `verified` unless there is a real blocker.
2. If learning is required, route every learning item before marking the workflow inactive. Open durable issues are valid routes; they should not keep the local workflow active forever.
3. `pull-work` should classify old `verified` records with `next_action.status: done` as cleanup candidates, not active implementation work.
4. Queue audits should flag `needs_decision` or `followup_required` records older than the local recovery window.
5. Cleanup should preserve links to PRs, issues, durable docs, and evidence summaries before deleting or archiving local runtime folders.

## Durable Closeout Shape

Durable closeout content is the handoff from working memory to project knowledge. Put it in the provider record, PR body, issue comments, release note, ADR, README section, schema docs, or runbook that owns the shipped behavior. It should record:

- shipped behavior or explicit non-shipped result
- provider change records such as PRs or issues
- verification evidence and residual gaps
- durable docs targets updated or intentionally skipped
- ADRs, README sections, schema docs, runbooks, or release notes created
- follow-up issues or learning-review records
- confirmation that `.flow-agents/` runtime artifacts remain untracked

## Completion Rule

Before merge to `main`:

1. Promote durable behavior, contracts, decisions, operations notes, and usage guidance into long-lived docs such as `README.md`, `docs/`, `docs/adr/`, schema docs, runbooks, changelogs, or provider records.
2. Make sure the durable record names the promotion targets and any accepted gaps.
3. Confirm `.kontourai/flow-agents/` runtime artifacts remain untracked.
4. Keep links to provider records, durable docs, or archived external evidence instead of relying on temporary local files.

`main` must not contain tracked files under `.kontourai/flow-agents/`. If runtime artifacts still seem necessary after merge, their durable content has not been promoted yet.

## Promotion Targets

Promote by ownership:

- user-facing behavior: `README.md`, product docs, or workflow usage docs
- architecture and policy decisions: `docs/adr/` or focused design docs
- workflow rules and gates: `context/contracts/`, `skills/`, `agents/`, and workflow docs
- schemas and API contracts: `schemas/` and contract docs
- operational behavior: runbooks, release notes, or deployment docs
- evidence and release state: PR body, provider checks, release records, or durable evidence docs
- follow-up work: provider-backed issues or backlog artifacts

Do not promote raw intermediate thinking wholesale. Promote the resulting decisions, requirements, evidence, and user-facing instructions.

## Enforcement

Runtime state remains ignored under `.kontourai/flow-agents/`. Static package validation fails if runtime artifacts are tracked. Reviewers should reject PRs that omit durable docs, source, schema, provider, or evidence updates needed to understand shipped behavior.
