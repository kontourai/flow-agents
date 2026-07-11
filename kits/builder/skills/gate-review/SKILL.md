---
name: "gate-review"
description: "Explicit advisory extension for reviewing apparent workflow gate blocks or misses from a completed trust bundle."
---

# Gate Review

## Role and Boundary

**Role:** explicit advisory extension outside generic routing.

Use only when the user explicitly asks to assess a suspected gate false block,
missed block, or gate behavior at closeout. This extension does not select a
flow, advance a run, apply a fix, or replace review, verification, or
learning-review.

It owns **no step-gate evidence**. It consumes existing trust data and produces
advisory review output only. Any remediation enters the normal planning and
delivery process after human selection.

## Inputs

Require an existing session directory with a `trust.bundle`; read `state.json`
only for lifecycle context. Use `flow-agents workflow status --session-dir
<session-dir>` to confirm the public run identity and current state when a run
is active.

The extension may also use expected criteria from the selected Work Item and
its adapters:

- **Work Item adapter:** acceptance criteria and expected workflow outcomes.
- **Repository adapter:** local policy and source context.
- **Change adapter:** review, verification, or release state associated with
  the suspected block.

These adapters are provider-neutral. A GitHub issue or pull request is an
optional labeled example, not a required source of truth.

## Extension Behavior

This extension is observational: it may inspect a `builder.build` session but
does not select, start, resume, advance, pause, release, or cancel its flow.
It classifies existing information and returns advisory output for a human to
route through normal planning, delivery, or learning work.

## Classification Method

Use `@kontourai/surface`'s `resolveInquiry(bundle, inquiry)` to produce
canonical `InquiryRecord` objects. Do not invent a bespoke substitute when the
Surface dependency is unavailable.

For each observed gate fire and each expected-but-absent criterion, classify:

| Condition | Calibration |
| --- | --- |
| A blocked claim is `disputed` or `rejected` | `correct` |
| A blocked claim is `verified` or `assumed` | `false_block` |
| An expected claim is absent, stale, unknown, or unresolved without a block | `missed_block` |

Every record must include a non-empty, advisory-only recommendation. Never
auto-apply or direct an automatic change. Preserve `InquiryRecord` schema
requirements, including identity, inquiry, outcome, resolution path, input
snapshot, status-function version, and resolution time.

## Output Responsibility

Produce these advisory artifacts in the existing session directory:

- `<slug>--gate-review.md`: session context, gate fires, suspected misses,
  advisory recommendations, and unresolved gaps.
- `gate-review.inquiries.json`: canonical `InquiryRecord` array.

Pass those outputs to `learning-review` as reviewer notes when learning review
is requested. Do not write learning output, modify flow definitions, or attach
step evidence on behalf of another primitive.

## Standalone and No-Active-Run Behavior

This extension may analyze a completed session without an active run. If there
is no active run but the session and trust bundle exist, perform the advisory
review without creating or resuming a workflow. If the session or trust bundle
is absent, report `NOT_VERIFIED` and produce no new session, evidence, or
workflow run.
