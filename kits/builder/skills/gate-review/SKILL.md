---
name: "gate-review"
description: "Enumerate gate fires and suspected misses from the session's Hachure trust.bundle, classify each as correct/false_block/missed_block using Surface's resolveInquiry to produce canonical InquiryRecords, route findings to learning-review, and propose advisory-only gate/flow fixes. Use mid-session after a goal-fit block or at closeout. Requires ADR 0010 Phase 1 (trust.bundle dual-write) to be present."
---

# Gate Review

Classify gate fires and suspected misses from the session's `trust.bundle` by calling Surface's `resolveInquiry` to produce canonical `InquiryRecord` outputs. Every finding is advisory — proposes a fix, never applies one.

## Contract

- **Advisory-only**: proposes fixes, never applies them. No finding may instruct auto-application of any fix.
- Never writes to `scripts/hooks/` or any flow file.
- Reads the local `trust.bundle` file only. Does NOT fall back to `command-log.jsonl`, `.goal-fit-block-streak.json`, or `evidence.json` direct reads as primary inputs.
- If no `trust.bundle` is present at `.flow-agents/<slug>/trust.bundle`, reports `NOT_VERIFIED` and stops. Does not silently degrade to bespoke sidecar reads.
- Routes all telemetry, `learning.json` writes, and correction routing through `learning-review`. Gate-review never calls `record-learning` directly.
- Reads `state.json` for lifecycle context only (phase, status). `state.json` is NOT a trust claim per ADR 0010.
- Reads `context/gate-awareness.md` for vocabulary alignment when available.
- Classification vocabulary (`correct`, `false_block`, `missed_block`) aligns with `context/gate-awareness.md` sections "Judge Gate Correctness" and "Missed-Block Diagnostic".
- Uses `@kontourai/surface`'s `resolveInquiry(bundle, inquiry)` to produce canonical `InquiryRecord` outputs per ADR 0003.
- If `@kontourai/surface` is unavailable, logs a warning and skips output. No bespoke fork fallback.
- **Builder Kit build flow**: gate-review operates on sessions created by `deliver` or `plan-work` with `--flow-id builder.build`. The session's trust.bundle contains both declared builder.* claims (e.g. `builder.verify.tests`) and legacy workflow.* shadow claims. Gate-review classifies all claims present in the bundle regardless of claimType prefix.

## Inputs

- `trust.bundle` at `.flow-agents/<slug>/trust.bundle` (produced by ADR 0010 Phase 1 dual-write in `workflow-sidecar`).

  **Dependency**: this file is NOT present at `origin/main @ a9b8fd6`; it requires ADR 0010 Phase 1 to be built and merged (owned by `arch/goal-fit-gate-trust-bundle`). Do not begin execution until Phase 1 has landed or a fixture is agreed with that owner.

  The bundle shape produced by `workflow-sidecar` (schemaVersion 3, source `"flow-agents/workflow-sidecar;statusFunctionVersion=1"`):
  ```json
  {
    "schemaVersion": 3,
    "source": "flow-agents/workflow-sidecar;statusFunctionVersion=1",
    "claims": [
      {
        "id": "<slug>-<checkId>.<surface>.<fieldOrBehavior>",
        "subjectType": "workflow-check",
        "subjectId": "<slug>/<checkId>",
        "surface": "flow-agents.workflow",
        "claimType": "workflow.check.test",
        "fieldOrBehavior": "<check summary>",
        "value": "pass|fail|skip",
        "createdAt": "<ISO-8601>",
        "updatedAt": "<ISO-8601>",
        "status": "verified|disputed|assumed|proposed|rejected|stale|unknown"
      }
    ],
    "evidence": [...],
    "events": [...],
    "policies": []
  }
  ```

  The claim `status` field is the canonically derived status (computed by `@kontourai/surface.deriveClaimStatus`). Status values and their meaning for gate-review:

  | `status` | Meaning |
  | --- | --- |
  | `verified` | Claim confirmed by matching evidence; a pass. |
  | `disputed` | Claim contradicted by evidence; a genuine failure. |
  | `assumed` | Claim accepted without direct evidence (e.g. `accepted_gap` criterion, `skip` check). |
  | `proposed` | Claim written but not yet evaluated. |
  | `rejected` | Claim explicitly rejected. |
  | `stale` | Claim data is outdated; gate had stale input. |
  | `unknown` | No event found; claim was never evaluated. |

- `state.json` at `.flow-agents/<slug>/state.json` (lifecycle context; not a trust input).
- Optional: seeded fixture `trust.bundle` path for testing before Phase 1 produces real bundles.

## Artifact Contract

Write the following artifacts under `.flow-agents/<slug>/`:

### `<slug>--gate-review.md`

Human-readable summary. Sections:

- `## Session` — slug, state.json phase/status at review time, trust.bundle schemaVersion
- `## Gate Fires` — one entry per classified InquiryRecord
- `## Suspected Misses` — missed_block InquiryRecords; expected criteria absent from the bundle
- `## Advisory Fixes` — proposed (NOT applied) fixes per InquiryRecord (from `answer.value.advisoryFix`)
- `## NOT_VERIFIED Gaps` — any classification that could not be completed (e.g. trust.bundle absent, Surface unavailable)
- `## Routed To` — `learning-review` invocation record

### `gate-review.inquiries.json`

Machine-readable array of canonical `InquiryRecord` objects validated against the hachure schema at `node_modules/hachure/schemas/inquiry-record.schema.json` (canonical `$id`: `https://kontourai.io/schemas/surface/inquiry-record.schema.json`).

Required fields per schema: `id`, `inquiry`, `outcome`, `resolutionPath`, `inputSnapshot`, `statusFunctionVersion`, `resolvedAt`.

The `outcome` field is the canonical Surface value: `"matched"` (claim found and resolved), `"derived"` (rule-based resolution), or `"unsupported"` (no matching claim — absent criterion).

The `answer` field carries gate-review's value-add:
- `answer.status` — canonical `TrustStatus` of the resolved claim (`"unknown"` when absent).
- `answer.value` — gate-review advisory object:
  ```json
  {
    "calibration": "correct | false_block | missed_block",
    "advisoryFix": "<non-empty advisory string>",
    "gateFired": true,
    "sessionSlug": "<slug>"
  }
  ```

The `calibration` field in `answer.value` is derived from `(outcome, answer.status, blockSignal.blocked)`:
- `"matched"` + `"disputed"|"rejected"` + `blocked=true` → `"correct"`
- `"matched"` + `"verified"|"assumed"` + `blocked=true` → `"false_block"`
- `"matched"` + `"stale"|"unknown"|"proposed"` + `blocked=false` → `"missed_block"`
- `"unsupported"` (absent claim) → `"missed_block"`

The `advisoryFix` in `answer.value` must be non-empty for every record. No record may have `auto_applied: true` or instruct automatic changes.

Example record:
```json
{
  "id": "my-session-gr-1",
  "inquiry": {
    "id": "my-session-gr-1",
    "question": "Was gate action on claim my-session/unit-tests... (status: verified) justified?",
    "askedBy": "gate-review",
    "askedAt": "2026-06-24T00:00:00Z",
    "target": { "subjectType": "workflow-check", "subjectId": "my-session/unit-tests", "fieldOrBehavior": "unit tests pass" }
  },
  "outcome": "matched",
  "resolutionPath": { "claimIds": ["my-session/unit-tests.flow-agents.workflow.unit tests pass"] },
  "answer": {
    "status": "verified",
    "value": {
      "calibration": "false_block",
      "advisoryFix": "Investigate why the gate blocked when claim ... has status verified ...",
      "gateFired": true,
      "sessionSlug": "my-session"
    }
  },
  "inputSnapshot": [{ "claimId": "my-session/unit-tests.flow-agents.workflow.unit tests pass", "status": "verified" }],
  "statusFunctionVersion": "1",
  "resolvedAt": "2026-06-24T00:00:00Z"
}
```

Invariants:
- Every record must have a non-empty `answer.value.advisoryFix`.
- No record may have `auto_applied: true`.
- `answer.value.calibration` must be one of `"correct"`, `"false_block"`, or `"missed_block"`.

After writing `gate-review.inquiries.json`, invoke `learning-review` passing the inquiries artifact path as an additional reviewer-notes input. Learning-review writes `learning.json` via `npm run workflow:sidecar -- record-learning`. Do NOT call `record-learning` from gate-review directly.

## Bundle-Claim to InquiryRecord Mapping

| Bundle claim condition | outcome | calibration | Rationale |
| --- | --- | --- | --- |
| Gate blocked AND claim has `status: "disputed"` or `"rejected"` | `matched` | `correct` | Gate saw a genuine failure; block was warranted. |
| Gate blocked AND claim has `status: "verified"` or `"assumed"` | `matched` | `false_block` | Gate blocked despite passing claims — acted on stale or incorrect data. |
| An expected claim is absent from the bundle entirely | `unsupported` | `missed_block` | Gate had no claim to evaluate. |
| A claim has `status: "stale"` and the gate did NOT block | `matched` | `missed_block` | Stale claim was present but gate did not fire on it. |
| A claim has `status: "unknown"` with no evidence trace | `matched` | `missed_block` | Claim was never evaluated; gate had no resolved evidence. |

Cross-reference with `state.json` phase at the time of the block to confirm the block was in an active workflow phase (not planning or archived).

## Workflow

### Step 1 — Locate trust.bundle

Resolve `.flow-agents/<slug>/trust.bundle`. The slug is the most recent active session (by `current.json` or `state.json` newest-mtime). If absent, surface the blocker:

```
[gate-review] trust.bundle absent — NOT_VERIFIED. Build ADR 0010 Phase 1 first.
```

Stop and surface the blocker to the user.

### Step 2 — Load Surface and resolve inquiries

Run `npm run workflow:sidecar -- gate-review <dir>`.

The sidecar writer:
1. Loads `@kontourai/surface` (ESM, fail-open dynamic import).
2. For each claim in the bundle: builds a `SurfaceInquiry` with a canonical `target` and calls `resolveInquiry(bundle, inquiry)`.
3. For each absent expected criterion (from `acceptance.json`): builds a `SurfaceInquiry` targeting the missing claim; `resolveInquiry` returns `"unsupported"`.
4. Derives `calibration` from `(outcome, answer.status, blockSignal.blocked)` using `deriveGateCalibration`.
5. Composes advisory `advisoryFix` string using `gateAdvisoryFix`.
6. Sets `answer.value = { calibration, advisoryFix, gateFired, sessionSlug }`.
7. Strips Surface-internal fields (`identityLinkIds`, `transitiveRuleIds`) to conform to the hachure schema.
8. Validates each record against `inquiry-record.schema.json` (fail-open).
9. Writes `gate-review.inquiries.json`.

### Step 3 — Classify each InquiryRecord

Apply the InquiryRecord calibration mapping:

**`correct`** — `outcome: "matched"`, claim `status: "disputed"` or `"rejected"`, `blocked=true`:
> Gate saw a genuine failure. Block was warranted. Advisory fix: close the gap and re-run.

**`false_block`** — `outcome: "matched"`, claim `status: "verified"` or `"assumed"`, `blocked=true`:
> Gate blocked despite passing claims. Advisory fix: investigate the block trigger; add freshness check.

**`missed_block`** — `outcome: "unsupported"` (absent) OR `status: "stale"|"unknown"|"proposed"`, `blocked=false`:
> Gate had no claim to evaluate or claim was unresolved. Advisory fix: ensure record-evidence writes the claim.

### Step 4 — Write human-readable summary

Write `<slug>--gate-review.md` with sections for Session, Gate Fires, Suspected Misses, Advisory Fixes, NOT_VERIFIED Gaps, and Routed To.

Optionally use `buildTrustReport(bundle)` + `formatTrustReportSummary(report)` from `@kontourai/surface` for the trust-state summary section.

### Step 5 — Invoke learning-review

Pass the `gate-review.inquiries.json` path as additional reviewer notes to `learning-review`. Do not call `record-learning` directly. Learning-review owns the `learning.json` write and correction routing.

Example invocation note:
```
gate-review InquiryRecords at .flow-agents/<slug>/gate-review.inquiries.json:
- <N> record(s): calibration counts
- gate fired: <true/false>
- calibration: correct=<n>, false_block=<n>, missed_block=<n>
Use these as reviewer notes for the learning-review correction record.
```

## Gates

- **Advisory gate**: every InquiryRecord must have a non-empty `answer.value.advisoryFix`. Gate-review must not complete without one per record.
- **No-auto-apply gate**: no record's advisory fix may instruct auto-application of any fix. Any proposed fix that starts with "Apply" or "Change" must be rephrased as "Propose" or "Investigate".
- **Phase-1 dependency gate**: if `trust.bundle` is absent, surface the blocker to the user rather than degrading silently to bespoke sidecars.
- **Surface gate**: if `@kontourai/surface` is unavailable, log and skip (no fork fallback).

## NOT_VERIFIED Gaps

| Gap | Description | Resolution trigger |
| --- | --- | --- |
| NV1 | trust.bundle absent at `origin/main @ a9b8fd6` — ADR 0010 Phase 1 not yet built | Phase 1 merged to main by `arch/goal-fit-gate-trust-bundle` owner |
| NV2 | AC1 seeded-session test fixture cannot be validated against real bundle shape | Phase 1 lands; coordinate with Phase 1 owner on exact bundle file path and claim array shape |
| NV3 | AC2 false_block / missed_block fixture depends on exact Phase 1 bundle structure | Same as NV2 |

AC1 and AC2 are `not_verified` pending ADR 0010 Phase 1. The classification logic is spec-complete against the real bundle shape (confirmed by `workflow-sidecar ensure-session` + `record-evidence` probe). Re-run seeded-session tests after Phase 1 lands.
