---
status: current
subject: Promotion gate
decided: 2026-07-02
evidence:
  - kind: issue
    ref: https://github.com/kontourai/flow-agents/issues/312
  - kind: session-archive
    ref: .kontourai/flow-agents/decision-registry-shape/decision-registry-shape--idea-to-backlog.md
  - kind: doc
    ref: docs/workflow-artifact-lifecycle.md
---

# Promotion gate

Archiving a delivered session is **gated on** promoting its durable residue. The
sequence is `final acceptance -> promote -> archive`; durable-residue extraction
is the archival act, not a parallel checklist chore.

## Decision

- The sidecar `promote` step records **what was promoted where** and writes a
  **promotion claim** into the session `trust.bundle`. The claim is
  **session-local by construction** — check kind `policy`, evidence type
  `policy_rule`, no command / `execution.label` — so it needs **no new
  reconcile-manifest entry** and can **never** become a `[not-run]` /
  unbacked-command divergence at CI `trust-reconcile`. The reconciler classifies
  it session-local and accepts it as an ATTESTED claim.
- The claim's evidence refs are the **durable doc paths written**
  (`docs/decisions/<slug>.md`, `CONTEXT.md`, `docs/learnings/*`, …); each is
  verified to exist on disk at record time (a missing path fails loud) and is
  mirrored into an auditable `promotion.json`. The claim is detected by the
  archive gate and validators via `claim.metadata.promotion`.
- An **explicit empty-promotion** path (`promote --none --reason "<why>"`) records
  an auditable no-residue claim, so "nothing needed promoting" is a recorded
  decision rather than a silent skip.
- `workflow-artifact-cleanup-audit` classifies a **delivered/accepted** session
  that reached a terminal shape **without** a promotion claim as a
  `cleanup_candidate` (archive blocked) with a remedy naming the `promote` step;
  **with** the claim (real residue or `--none`) it stays `terminal_done`.
  Already-`archived` sessions are past the gate and are never re-flagged (no
  backfill of historical archives).

## Rationale

Docs-promotion was a Final Acceptance checklist item done inconsistently; the
2026-07 archival sweep retired ~40 sessions whose promotion had happened ad hoc.
Making promotion **structural** — a claim the archive classifier checks — means no
delivered work is retired without its knowledge extracted. Reusing the existing
trust.bundle / stop-gate machinery (rather than a parallel mechanism) keeps the
signal visible to validators without new manifest surface, and the session-local
claim shape guarantees the gate can never masquerade as a CI-reconcilable command.
