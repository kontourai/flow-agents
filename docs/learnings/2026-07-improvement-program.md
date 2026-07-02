---
title: "2026-07 Improvement Program — Learning Review"
---

# 2026-07 Improvement Program — Learning Review

This document records durable learnings from a multi-week, multi-repository improvement
program run across the Kontour portfolio in June and July 2026. The program touched
Flow Agents, Surface, Veritas, Flow, Survey, Traverse, and the shared hachure trust-bundle
schema. Every finding below was hit empirically during the program and resolved or worked
around; none are speculative.

It is written for a future maintainer who was not present for the program. Where a finding
implies a rule you should keep following, that rule is stated explicitly. Cross-repository
pull requests and issues are linked so you can trace the underlying change.

## Scope and source material

- Corroborating provider issues: [flow-agents#267](https://github.com/kontourai/flow-agents/issues/267),
  [flow-agents#268](https://github.com/kontourai/flow-agents/issues/268),
  [flow-agents#281](https://github.com/kontourai/flow-agents/issues/281).
- Representative pull requests:
  - Flow Agents: [#264](https://github.com/kontourai/flow-agents/pull/264) (cross-kit
    dependencies, skill-collision fixes, sidecar governance),
    [#266](https://github.com/kontourai/flow-agents/pull/266) (manifest-based reconcile,
    claim classification, loud attestations),
    [#269](https://github.com/kontourai/flow-agents/pull/269) (veritas-governance kit —
    readiness→trust-bundle adapter),
    [#277](https://github.com/kontourai/flow-agents/pull/277) (migrate to
    `@kontourai/surface` 2.0.0, `Claim.facet` rename).
  - Surface: [#103](https://github.com/kontourai/surface/pull/103) (order-independent
    multi-producer merge; hachure 0.7.0 conformance),
    [#104](https://github.com/kontourai/surface/pull/104) (sync to hachure 0.8.0,
    vendor-neutral `$id`s), [#105](https://github.com/kontourai/surface/pull/105)
    (`Claim.surface` → `facet`, spec 0.9.0 parity — a breaking change).
  - Veritas: [#107](https://github.com/kontourai/veritas/pull/107) (blocking failures win
    over `promotion_allowed` short-circuit), [#109](https://github.com/kontourai/veritas/pull/109)
    (migrate `Claim.surface` → `facet`, Surface ^2.0.0, schemaVersion 5).
  - Flow: [#100](https://github.com/kontourai/flow/pull/100) (migrate to Surface 2.0.0 —
    shipped as a `chore:` and therefore went unreleased; see Finding 6),
    [#101](https://github.com/kontourai/flow/pull/101) (trust bundles emit `facet` +
    schemaVersion 5; Surface 2.0, hachure 0.9).
  - Survey: [#100](https://github.com/kontourai/survey/pull/100) (migrate to Surface 2.0.0
    facet rename), released via [#99](https://github.com/kontourai/survey/pull/99) /
    [#101](https://github.com/kontourai/survey/pull/101).
  - hachure trust-bundle schema releases 0.6.0 through 0.9.0, which drove the coordinated
    Surface / Veritas / Flow / Survey / Flow Agents migrations above.

The rest of this document is organized by finding. Each finding states what happened, why
it matters, and the working discipline or fix to carry forward.

## 1. Trust-ledger write discipline

The trust ledger (`trust.bundle` plus its `evidence.json` / critique inputs) has write
semantics that are easy to corrupt if you interleave commands:

- `record-evidence` **replaces** `trust.bundle` wholesale. At the time of the program it
  rebuilt the bundle with a hardcoded `critiques: []`, so any previously recorded critique
  was silently dropped.
- `record-critique` is **append-only** and has no supersession mechanism: a reviewer cannot
  close or retract a disputed finding once written ([flow-agents#267](https://github.com/kontourai/flow-agents/issues/267)).
- The checks/critiques round-trip through the bundle is contaminating: prior critique claims
  get re-absorbed as command-less `test_output` checks, turning a critique claim into a
  divergent, command-less check ([flow-agents#268](https://github.com/kontourai/flow-agents/issues/268)).
  This is amplified under `--flow-id`, where a **single** critique write is enough to
  contaminate the ledger.

**Working discipline until the tooling is fixed:**

1. Record **all** evidence first.
2. Record **at most one** critique write, and make it the **last** write.
3. Never run any `record-*` command after that final critique write.
4. If a ledger becomes contaminated, **restart the session** rather than trying to iterate
   or repair a contaminated ledger in place.

This program's learning-review session itself follows the rule: it was created with
`ensure-session` **without** `--flow-id` precisely to avoid the single-critique-write
amplification described above.

## 2. Post-merge ledger staleness

A session whose `trust.bundle` was frozen mid-iteration causes stop-gate "caught
false-completion" storms after the branch merges. The stale iteration claims are recomputed
in a changed context (the merged tree no longer matches the frozen claims), and the stop gate
repeatedly flags the session as falsely complete.

**Pattern to recover:** rebuild the bundle from the current `evidence.json` via
`record-evidence`, then re-advance state. Do not hand-edit the frozen bundle; regenerate it
from current evidence so the claims match the post-merge tree.

## 3. Evidence must be executable in the CI/backstop context

Evidence checks are re-run by CI and by the backstop reconciler, not just locally. Several
checks passed locally but failed in CI because they were not executable in that context. Keep
evidence portable:

- Check commands must be **repo-root-relative** and must reference files that live **inside
  the session directory** (for example under `verify-scratch/`), never an agent's private
  scratchpad that does not exist in CI.
- Summaries must be **runnable commands**. For prose that is not a command, use the
  `true # ...` form so the "command" still exits zero when executed.
- Reconcilable claims need **manifest-exact bare labels** — no environment-variable
  annotations on the label — so the reconciler can match them against the manifest.
- Keep reconcilable sets **small**. `runCommand` enforces a 180-second per-command timeout;
  heavy test suites trip that timeout in CI while passing locally. Split or scope the suite
  so each reconciled command finishes well under the limit.

## 4. Critique semantics and resolved sessions

Under the current validator rule, a top-level `pass` verdict forbids any `fail` or
`not_verified` member claims. Consequently a **resolved** session cannot retain historical
`verdict: fail` critiques — the validator rejects the bundle even though the failure was
genuine and later fixed.

**Reconciliation pattern:** move the historical failing critique to `superseded` and then
`comment`, preserving the original outcome in the summary text so the audit trail survives.
The `fail` verdict is not deleted from history; it is superseded, and the summary records
what the original verdict was and how it was resolved.

This deserves an explicit convention note, and possibly a validator/schema affordance for a
first-class `superseded_by` relationship so the original verdict can be preserved structurally
rather than only in prose. That tooling gap is filed as a follow-up issue (see below).

## 5. Shim scope coupling in cross-repo schema migrations

Surface 2.0's read-tolerance shim (the compatibility layer that accepts both the old
`Claim.surface` and new `Claim.facet` shapes) only protects consumers that go through
**Surface's JavaScript API**. Anything that validates against the hachure JSON Schema
**directly** bypasses the shim and breaks. During this program that included:

- Flow's Ajv gate (validates bundles against the raw schema),
- Veritas's schema dependency,
- Flow Agents `attach-evidence` using a **vendored** copy of the old hachure schema.

Each of these had to bump hachure **in lockstep** with the Surface bump; the shim did not
cover them.

**Rule for future cross-repo schema migrations:** map **both** axes before you start —
(a) the JS-API consumers, which the shim protects, and (b) the raw-schema validators, which
it does not. Every raw-schema validator (including vendored schema copies) must be bumped in
the same coordinated wave. See Surface [#105](https://github.com/kontourai/surface/pull/105),
Veritas [#109](https://github.com/kontourai/veritas/pull/109), Flow
[#101](https://github.com/kontourai/flow/pull/101), Survey
[#100](https://github.com/kontourai/survey/pull/100), and Flow Agents
[#277](https://github.com/kontourai/flow-agents/pull/277) for the coordinated set.

## 6. Release mechanics

Two independent release-mechanics traps surfaced:

- **release-please ignores `chore:` commits.** Flow [#100](https://github.com/kontourai/flow/pull/100)
  shipped real functionality (the Surface 2.0 migration) as a `chore:` commit, so
  release-please never cut a release and the functionality sat unreleased until a subsequent
  `feat!:` signal commit ([#101](https://github.com/kontourai/flow/pull/101)) triggered the
  release. If a `chore:` PR changes shipped behavior, it will not be released on its own —
  pair it with a `feat:`/`fix:`/`feat!:` signal commit or it stays dark.
- **GitHub App installation repo-access is a separate axis from org secrets/vars grants.**
  A Traverse release was blocked because the GitHub App was not installed on that repository,
  which is distinct from whether org-level secrets and variables were granted. App
  installation repo-access is org-owner-only, so this class of block cannot be self-resolved
  by the release author and must be escalated to an org owner.

## 7. Runtime-artifact hygiene

Bulk worktree operations reset filesystem `mtime`s en masse. Any recency heuristic based on
`mtime` is therefore unreliable after a sweep. Session recency must be read from
`state.json`'s `updated_at` field, not from file `mtime` (established during the WS6 sweep —
the WS6 sweep was the pass that audited and pruned stale local runtime sessions).

The `workflow-artifact-cleanup-audit` CLI is **dry-run only**: it classifies sessions into
active WIP, cleanup candidates, terminal done records, active learning follow-ups, and
invalid sidecars, but it does not delete, archive, or rewrite anything and has no apply mode.
An apply mode may be worth filing so cleanup can be executed, not just recommended. That
tooling gap is filed as a follow-up issue (see below).

## 8. Gate operations

Operational discipline for running gates and merging, learned the hard way during parallel
waves:

- **Never dispatch fixes while gates are running.** Wait for **all** outstanding gates to
  finish before acting on any result; dispatching a fix mid-run races the gate and produces
  confusing, interleaved state.
- **Run mutation testing only in scratch copies**, never against the working tree the gate is
  evaluating.
- **Keep `gh pr merge` stderr visible.** Do not swallow it; the merge failure reasons you
  need (behind-base, pending checks, blocked) come through stderr.
- Use `gh pr merge --auto` for pending checks so the merge lands when checks go green, and use
  branch update (`update-branch`) when a PR is `BEHIND` the base.

## Follow-up tooling issues

Findings 4 and 7 imply concrete Flow Agents tool changes. Both were checked against the open
issue list for duplicates and filed fresh:

- Finding 4 → [flow-agents#282](https://github.com/kontourai/flow-agents/issues/282): a
  validator/schema affordance for `superseded_by` on critique claims, so a resolved session
  can preserve a historical `fail` verdict structurally rather than only in the summary prose.
- Finding 7 → [flow-agents#283](https://github.com/kontourai/flow-agents/issues/283): an
  apply mode for `workflow-artifact-cleanup-audit`, so the dry-run classification can be
  executed.

Both issues were checked against the open issue list before filing; no duplicates existed.
