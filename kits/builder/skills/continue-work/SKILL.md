---
name: "continue-work"
description: "Advance a multi-slice work item to its next increment via a fresh-context handoff. Use when one or more slices of a multi-slice issue have landed and the next undone slice should be built. Routes the next slice through pull-work + pickup-probe (never around the gate), restores prior slices from the durable record as precedent, and hands off in a fresh context per ADR 0013."
---

# Continue Work

Advance a multi-slice work item to its **next increment**, in a fresh context, with the already-landed slices as precedent.

This skill is **orchestration, not new machinery.** It composes existing pieces and must never reimplement them:

- `pull-work` already owns *selection* plus the `pickup-probe` gate, and already handles "continue / keep going / pick up the next" intents. continue-work routes the chosen slice **through** `pull-work` / `pickup-probe`, never around it.
- The **resume surface** (#153) owns restoring an item's durable record (`state.json` lifecycle + `handoff.json` next-steps/blockers + plan artifact + `trust.bundle` trust summary) into context. continue-work consumes that surface; it does not re-derive the record.
- **ADR 0013** establishes `pull-work` as the clean *context-reset* seam: a fresh window per increment, selective compaction, status-gated reuse. continue-work spawns the next increment as a fresh-context workflow seamed at `pull-work`.
- The **fresh-handoff** pattern (spawn a new context for the next increment) is the delivery mechanism.

continue-work ties these together for **one job**: take a multi-slice work item that has at least one slice landed and more remaining, determine the next undone slice, route it through the gate, and hand it off fresh with the prior slices as the model.

## When To Use / When Not

**Use** when:

- A multi-slice issue has **at least one slice landed and more remaining** (for example #106), and the request is "continue", "pick up the next slice", "keep going on this issue", or "do the next increment".

**Do not use** when:

- The request is **brand-new work** with nothing landed yet — that is selection from the backlog. Route to `pull-work`.
- The request is to **resume the *same* interrupted slice** after a restart (same in-flight slice, mid-execution, picking up new hooks/logic) — that is the resume surface (#153), which reconstructs `state.json` + `handoff.json` + plan + `trust.bundle` for the *same* increment. continue-work advances to the *next* increment; it does not re-enter an unfinished one.

For that same-slice case, when a canonical Builder Flow run already exists, restore
its sidecar/current projection with `flow-agents builder-run recover --session-dir
.kontourai/flow-agents/<slug>` before following the resume surface. The command
derives run identity from the session slug and only loads, validates, and projects;
never invent or supply a run id or step, and use `builder-run sync` separately only
when recorded evidence should be attached and evaluated.

If the boundary is ambiguous (is this the next slice or the same one?), stop and ask one question before routing. Do not silently assume.

## Boundary (ADR 0014)

Home is the **Builder Kit** — developer orchestration over issues, slices, and PRs — alongside `pull-work` and `deliver`. The underlying *fresh-handoff primitive* is generic. If a non-developer kit later needs continuation, **graduate the primitive** per ADR 0014; do not fork continue-work into each kit.

## Inputs

- The multi-slice work item (an issue ref) with at least one slice landed and more remaining.
- Repository or working directory and the owning kit/kit-dir.
- The durable record for the item when one exists, restored via the resume surface (#153): `state.json`, `handoff.json` next-steps/blockers, the plan artifact, and a one-line `trust.bundle` summary of what is already verified.
- The merged PRs and commits that reference the issue (the landed slices), available as `git show <sha>` precedent.
- `AGENTS.md` "Operating discipline (working agreements)" — the operating agreements that travel with every increment.

## Workflow

### 1. Restore the durable record (resume surface, #153)

Before doing anything else, restore the item's durable record into context through the resume surface (#153) rather than re-deriving it from chat memory: `state.json` lifecycle, `handoff.json` next-steps and blockers, the plan artifact, and a one-line `trust.bundle` summary of what is already verified. This is *restore for context*, not *resume the slice* — continue-work is advancing to the next increment, so already-verified prior slices stay verified and are not re-proven.

If no durable record exists for the item, record that gap and rely on the issue body plus merged PRs/commits as the authoritative history.

If the item was taken over from a stale incumbent (a `reclaimable` selection resumed via pull-work's **Takeover Protocol**, #294 / ADR 0021 §5), restoring the durable record IS the resumption: the deterministic slug points at the incumbent's existing `.kontourai/flow-agents/<slug>/`, and you continue the incumbent's branch (the `resume_branch` from `takeover-preflight`/the supersede output) — never a new branch, never a restarted plan. Takeover is resumption, not restart.

### 2. Determine the next undone slice

From the issue body plus the merged PRs and commits referencing the issue, determine which slices have **landed** and which is the **next undone slice**.

- Read the issue body for the slice list / acceptance breakdown.
- List merged PRs and commits referencing the issue (`gh pr list --search <issue>`, `git log --grep`) to see which slices are done.
- The next undone slice is the thinnest remaining meaningful increment. If the remaining work is ambiguous or no longer matches the issue, route back to `idea-to-backlog` instead of inventing scope.

### 3. Route the slice THROUGH pull-work + pickup-probe (the gate, never around it)

Hand the chosen next slice to `pull-work`, then `pickup-probe`. **Never bypass this gate.** A continuation instruction ("continue", "pick up the next") may justify inspecting the queue, but it must not skip per-item pickup Probe evidence — see pull-work's Pickup Gate ("A stale broad continuation instruction … may allow queue inspection but must not bypass per-item pickup Probe evidence") and its post-merge rule ("automatic continuation … cannot enter planning or execution for the next work item until a fresh pickup Probe record exists for that newly selected item").

- `pull-work` enforces board selection, WIP/shepherding, dependency, grouping, freshness (planned-base drift), and worktree logic for the selected slice, and writes the pull-work artifact.
- `pickup-probe` then challenges the slice against the repository — scope, acceptance quality, provider state, drift, conflict risks — and records the pickup Probe outcome, planning readiness, decisions, unresolved questions, and accepted gaps.
- continue-work does **not** reimplement either step's logic. It supplies them the next slice and the precedent (prior slices) and consumes their artifacts. The evidence that the gate ran lives in the pull-work / pickup-probe artifact referenced by the handoff (`probe_status`, `probe_artifact_ref`).

Do not enter planning or execution until a fresh pickup Probe record exists for this slice.

### 4. Assemble the minimal handoff

Once the slice passes the gate, assemble the **minimal handoff** — the smallest durable context a fresh agent needs:

- the **slice's spec**: `gh issue view <issue>` (the issue is the spec);
- the **operating agreements**: `AGENTS.md` "Operating discipline";
- the **precedent**: the prior slices' merged PRs as the model (`git show` them);
- the **gate evidence**: the pull-work / pickup-probe artifact ref proving the slice passed the gate.

The minimal template it encodes:

```
Implement [slice N of #ISSUE] in <repo> — the <kit>.
Read first: AGENTS.md 'Operating discipline'; gh issue view ISSUE (your slice's spec);
the prior slices as your model (PRs … — git show them).
Then: scope → minimal impl reusing existing ops (consume-never-fork) → tests stay green +
cover new code → PR referencing #ISSUE, <kit-dir> only. Don't merge; get CI green and report.
```

### 5. Execute in a fresh context (ADR 0013)

Hand the minimal template off into a **fresh context** — either spawn a sub-agent for the next increment, or hand the prompt to the operator for a fresh session. Per ADR 0013, the new increment rebuilds its context from durable artifacts (the issue, AGENTS.md, prior PRs, the gate artifact), not from this conversation's history. The fresh-handoff is the delivery seam: a sharp window for the new slice, continuity carried by the durable system.

The fresh-context agent runs the standard Builder Kit build for its slice (`plan-work` → `execute-plan` → `review-work` → `verify-work`), which it may reach via `deliver`. continue-work does not re-run those primitives in-line; it sets up the handoff and lets the fresh context execute.

### 6. Verify and report — do not merge

After the slice is built:

- Confirm the **boundary held** (only `<kit-dir>` changed) and the **suites are green** (the slice's tests cover the new code and nothing regressed).
- Report: which slice advanced, the gate evidence (pull-work / pickup-probe artifact), the precedent PRs used, the verification result, and the PR.
- **Do not merge without authorization.** Get CI green and report back.

## Composition Gate

continue-work has correctly composed the pieces only when:

- the durable record was restored via the resume surface (#153), or a missing-record gap is recorded;
- the next undone slice was derived from the issue body plus merged PRs/commits, not invented;
- the slice was routed **through** `pull-work` + `pickup-probe`, with a fresh pickup Probe record (`probe_status`, `probe_artifact_ref`) referenced by the handoff — the gate was not bypassed;
- the minimal handoff carries the issue spec, `AGENTS.md` operating agreements, and the precedent PRs;
- the next increment runs in a **fresh context** per ADR 0013;
- the boundary held, suites are green, and the change is reported without merging.

If any item fails, stop and surface the gap rather than proceeding.

Refs: #106 (proving ground), #153 (resume surface), #168 / ADR 0013 (context lifecycle), #164 (operating agreements), ADR 0014 (core vs domain-kit boundary).
