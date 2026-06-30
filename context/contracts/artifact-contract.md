# Workflow Artifact Contract

Workflow artifacts are the resumable local handoff surface between orchestrators, workers, verifiers, hooks, evals, and future sessions.

## Artifact Root

Use the task artifact root defined by the active distribution's bundle instructions. This source repo writes and discovers non-durable task artifacts under `.kontourai/flow-agents/<slug>/` by default.

Do not hard-code a different root inside a skill or agent when the distribution has already defined one.

In this source tree, `.kontourai/flow-agents/<slug>/` is the local runtime/session state root by default. `.flow-agents/` is reserved for Flow Agents-owned durable config/install state; do not put non-durable workflow sessions there. Exported agent bundles may map the runtime root to a distribution-specific path through their bundle instructions; treat those paths as local runtime roots, not durable product documentation.

The artifact root is local working memory unless a workflow explicitly promotes or publishes it:

- Keep active plans, handoffs, sidecars, temporary evidence, verifier notes, and parallel-worker progress in the runtime root.
- When in-progress planning must be reviewable across people or sessions, promote the durable summary, decisions, and evidence pointers into docs, source, schemas, or provider records.
- Archive completed local records under `<artifact-root>/<slug>/archive/<date>/` when they are useful for audit or recovery but should not remain the active session.
- Promote stable decisions, usage guidance, release notes, and accepted architecture changes into durable docs such as `docs/`, ADRs, changelogs, or provider-backed descriptions/comments.
- Publish provider records only through the provider adapter or explicit publish-change step. Provider records may link back to local artifacts, but they do not make local runtime files durable by themselves.
- Do not commit local workflow runtime roots such as `.kontourai/flow-agents/<slug>/` as durable policy unless a repository-specific contract explicitly says that artifact is promoted.
- Do not commit local workflow runtime roots such as `.kontourai/flow-agents/<slug>/`; final acceptance must promote durable content before merge.

## Persistence Integrity

Writing a durable artifact must **fail loud, never fail-open.** If a record (state, evidence, a
trust.bundle, a claim) cannot be persisted — a missing dependency, a validation failure, an I/O
error — the operation **fails with the reason**; it must not return success while silently
dropping the write. A silently-skipped persist is **data loss**, not a degraded mode, and is
invisible to the caller that depended on it. Callers act on persistence **return values**, not
just thrown exceptions. (See #160: an ignored `{written:false}` from the bundle writer dropped
records under concurrency.)

## Required Artifact Types

### Structured Sidecars

Markdown artifacts remain the human-readable handoff surface. JSON sidecars are the machine-readable recovery and gate surface. When a workflow creates or updates the corresponding information, write the sidecar beside the Markdown artifacts in `.kontourai/flow-agents/<slug>/`.

Draft sidecars:

- `state.json` follows `schemas/workflow-state.schema.json`
- `acceptance.json` follows `schemas/workflow-acceptance.schema.json`
- `evidence.json` follows `schemas/workflow-evidence.schema.json`
- `handoff.json` follows `schemas/workflow-handoff.schema.json`
- `critique.json` follows `schemas/workflow-critique.schema.json`
- `release.json` follows `schemas/workflow-release.schema.json`
- `learning.json` follows `schemas/workflow-learning.schema.json`

Sidecar rules:

- Keep `schema_version` at `1.0` until the schema changes incompatibly.
- Keep `task_slug` stable across all sidecars for a workflow.
- Prefer `npm run workflow:sidecar --` for creating and updating sidecars. If a harness cannot run the writer, produce equivalent JSON and validate it with `npm run workflow:validate-artifacts --`.
- Use `npm run workflow:sidecar -- ensure-session` when available to create or select the current `.kontourai/flow-agents/<slug>/` session artifact before substantial work starts.
- Update `state.json` at phase transitions.
- Create or update `acceptance.json` when planning defines or changes acceptance criteria.
- Create or update `evidence.json` when verification or evidence-gate records proof.
- Create or update `handoff.json` when work pauses, blocks, delegates, or hands off to a future session.
- Use `npm run workflow:sidecar -- advance-state` when available to keep `state.json` and `handoff.json` synchronized during phase transitions.
- Runtime `state.json` and `handoff.json` writes from the sidecar writer must pass through the transition guard. Flow owns transition semantics; Flow Agents enforces runtime sidecar transitions through an interim Flow Definition-compatible adapter until Flow core provides the authoritative validator.
- Rejected runtime transitions must fail closed before mutating `state.json` or `handoff.json` and should append diagnostics to `transition-diagnostics.jsonl` beside the workflow sidecars. Route-back attempt counts, when applicable, belong in `transition-attempts.json` rather than `state.json`.
- Create or update the configured critique artifact/sink when a reviewer, critique subagent, or human review pass evaluates the workflow; locally this is materialized as `critique.json`.
- Create or update `release.json` when release-readiness records a merge, release, deploy, hold, or rollback decision.
- Create or update `learning.json` when a learning review turns completed work, repeated friction, or accepted critique into system improvements.
- Do not let sidecars silently contradict the Markdown artifact. If they disagree, the sidecar is the machine-readable gate input and the Markdown summary should be corrected.
- Record `NOT_VERIFIED` in sidecars as `not_verified`; do not omit uncertain checks.
- For substantial work, critique findings must be `fixed`, `accepted`, `deferred`, or `false_positive` before marking critique `pass`; open findings block a pass.
- Treat sidecars as authoritative gate inputs. Temporary verifier-local mismatch notes are observations only; before terminal delivery, the orchestrator must update or reconcile `acceptance.json`, `evidence.json`, `release.json`, and the final Markdown summary so stale mismatch notes are superseded by final evidence or release validation.

Evidence reference rules:

- `acceptance.criteria[].evidence_refs`, `evidence.checks[].artifact_refs`, and `evidence.external_evidence[].ref` use structured evidence reference objects. Legacy bare strings are not part of the schema contract.
- Every evidence reference has `kind`; allowed kinds are `source`, `command`, `artifact`, `provider`, and `external`.
- Source evidence references identify the code or documentation that supports an implementation-behavior claim and include `file`, `line_start`, `line_end`, and `excerpt`. Include `url` when a provider permalink is known.
- Provider source URLs should be immutable GitHub blob URLs pinned to a commit SHA, for example `https://github.com/<owner>/<repo>/blob/<commit-sha>/<path>#L12-L24`. Do not use branch-relative blob URLs for final provider, PR, issue, closure, or release comments.
- Before a commit/provider permalink exists, local `file` plus line fields and `excerpt` are acceptable temporary evidence. Evidence Gate should treat those refs as publish-change inputs and prefer upgrading them to immutable provider URLs before release or closure.
- Command and test proof may use `kind: "command"` with `excerpt`, `summary`, or `url` for the relevant log/artifact. Behavior acceptance claims should cite both command/test proof and source evidence unless source evidence is not applicable.
- If source evidence is not applicable, record the reason as a gap, `not_verified`, or accepted gap rather than replacing source evidence with broad prose.

Provider, PR, issue, closure, and final acceptance comments that claim implementation behavior must include an `Acceptance Evidence` table:

| AC id | Status | Command/Test Evidence | Source Evidence / Permalinks | Gaps |
| --- | --- | --- | --- | --- |

Each row maps one acceptance criterion id to its status, concrete command/test evidence, source refs or immutable provider permalinks, and any `NOT_VERIFIED` or accepted gaps. A prose-only summary is not enough for clean closure when behavior is claimed.

Canonical vocabulary:

`state.phase` is the canonical lifecycle vocabulary for machine-readable workflow state. It does not include review as a phase; review-work is represented by the required critique artifact/sink for the workflow, with `critique.json` as the current local sidecar materialization.

| Field | Values |
| --- | --- |
| `state.status` | `new`, `planning`, `planned`, `in_progress`, `blocked`, `verifying`, `verified`, `needs_decision`, `not_verified`, `failed`, `delivered`, `accepted`, `archived` |
| `state.phase` | `idea`, `backlog`, `pickup`, `planning`, `execution`, `verification`, `goal_fit`, `evidence`, `release`, `learning`, `done` |
| `next_action.status` | `continue`, `needs_user`, `blocked`, `done` |
| `acceptance.criteria[].status` | `pending`, `pass`, `fail`, `not_verified`, `accepted_gap` |
| `acceptance.goal_fit.status` | `pending`, `pass`, `fail`, `not_verified`, `accepted_gap` |
| `evidence.verdict` | `pass`, `partial`, `fail`, `not_verified` |
| `evidence.checks[].status` | `pass`, `fail`, `not_verified`, `skip` |
| `critique.status` | `pending`, `pass`, `fail`, `not_required` |
| `critique.critiques[].verdict` | `pass`, `comment`, `fail`, `not_verified` |
| `critique.critiques[].findings[].severity` | `critical`, `high`, `medium`, `low`, `info` |
| `critique.critiques[].findings[].status` | `open`, `accepted`, `fixed`, `deferred`, `false_positive` |
| `learning.status` | `pending`, `learned`, `followup_required`, `blocked` |
| `learning.records[].outcome` | `success`, `failure`, `mixed`, `unknown` |
| `learning.records[].routing[].target` | `rule`, `skill`, `power`, `agent`, `eval`, `doc`, `backlog`, `knowledge`, `none` |
| `release.decision` | `merge`, `release`, `deploy`, `hold`, `rollback_required` |
| `release.gates[].status` | `pass`, `hold`, `not_required`, `not_verified` |
| `release.rollback_plan.status` | `ready`, `not_required`, `missing` |

Sidecar ownership by phase:

- Planning owns initial `state.json`, `acceptance.json`, and `handoff.json`.
- Execution updates progress in the Markdown session artifact and uses `advance-state` when available to update `state.json` or `handoff.json` when work blocks, pauses, or changes phase.
- Verification owns `evidence.json` check details and criterion status updates in `acceptance.json`.
- Critique reviewers own the configured critique artifact/sink findings and resolution state; locally this is materialized as `critique.json`.
- Release reviewers own `release.json` gate decisions and operational readiness records.
- Learning reviewers own `learning.json` routing into durable improvements.
- Evidence Gate owns final evidence assessment, residual gaps, and next-step handoff updates.
- Release Readiness owns release/final-acceptance state after evidence passes.

Final-state reconciliation:

- Verifiers may report that local Markdown and sidecars disagree when they inspect a workflow before orchestration has finished.
- The terminal delivery state must be based on the final sidecars plus final orchestrator evidence, not on an earlier verifier-local warning.
- If the final sidecars still disagree with the Markdown artifact, the workflow cannot be treated as a clean pass.
- If the orchestrator updates the sidecars and records final validation, the final summary should name the reconciled sidecars and supersede earlier mismatch notes instead of carrying both as equal truth.

### Session

The session artifact is the recovery point for the overall workflow.

Required fields or sections:
- title
- branch
- worktree
- created
- status
- type
- iteration when the workflow can loop
- plan reference
- execution progress
- verification report
- goal fit status when delivery is involved
- final acceptance status when merge, release, or durable documentation is involved

### Plan

The plan artifact is the source of truth for implementation.

Required frontmatter:
```yaml
---
role: plan
parent: <session basename>
created: <ISO date>
---
```

Required sections:
- `## Plan`
- `## Definition Of Done`
- implementation waves

### Review Or Verification

Review and verification artifacts are report-only evidence. They must not contain fixes applied by the reviewer or verifier.

Review artifacts feed the configured critique artifact/sink, locally materialized as `critique.json`, and describe code, security, architecture, standards, or maintainability findings. Verification artifacts feed `evidence.json` and describe build/test/runtime proof mapped to acceptance criteria. Do not collapse critique findings and evidence checks into one gate unless a legacy workflow has no separate review stage.

Required frontmatter:
```yaml
---
role: review
parent: <session basename>
created: <ISO date>
verdict: PASS | PARTIAL | FAIL | NOT_VERIFIED
---
```

Required sections:
- commands or checks run
- evidence mapped to acceptance criteria
- failures or gaps
- verdict

## Continuity Rules

- Update the session artifact at each phase transition.
- Preserve links from session to plan, review, verification, final docs, and archived artifacts.
- Record `NOT_VERIFIED` explicitly. Do not convert it to PASS or hide it in a summary.
- Treat artifacts as working memory until final acceptance; promote durable decisions and usage notes to long-lived docs after merge or acceptance.
