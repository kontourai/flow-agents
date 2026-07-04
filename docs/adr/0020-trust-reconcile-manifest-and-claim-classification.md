---
title: "ADR 0020: Trust-Reconcile Manifest, Claim Classification, and Waivers"
---

> **FROZEN — immutable history.** Superseding/current decisions live in [`docs/decisions/`](../decisions/index.md). Do not edit.

# ADR 0020: Trust-Reconcile Manifest, Claim Classification, and Waivers

Status: Accepted

Relates to: ADR 0004 (self-grading gate), ADR 0010 (trust.bundle as the primary
verification artifact), ADR 0017 (the anti-gaming trust security model + external CI
anchor). This ADR refines the CI anchor's *reconcile* step; it does not change the
layered-defense posture ADR 0017 established.

## Context

PR #264 was this repository's first real `trust.bundle` publication through the CI trust
anchor (`scripts/ci/trust-reconcile.js`, ADR 0017). It could not pass, and the failure was
architectural, not incidental:

1. **Single opaque composite command.** The reconciler resolved exactly one canonical
   verify command — `package.json scripts["trust-reconcile-verify"]` = `npm run build &&
   npm run eval:static` — and reconciled a claimed pass only when the claim's
   `evidence.execution.label` was byte-identical to that composite string. Any honest,
   granular, per-acceptance-criterion command (a single lane check, a narrower test, a
   browser check) was, by construction, "a claimed pass CI never ran" → divergence.

2. **Every check hardcoded as `test_output`.** `buildTrustBundle`
   (`src/cli/workflow-sidecar.ts`) stamped `evidenceType: "test_output"` on *every* check
   regardless of `check.kind`, and only stamped `execution.label` when the local
   command-log capture happened to run it. A browser check, a manual verification, a
   provider/CI check, or a diff review therefore looked identical to a `test_output`
   claim CI never ran.

3. **No waiver path.** An honestly-accepted gap had no sanctioned, visible way through the
   anchor.

The net effect: no bundle carrying honest, granular, mixed evidence could pass, and the
deliver skill's own publish step was unsatisfiable for any session reporting more than one
composite command. PR #264's bundle was withdrawn.

## Decision

Redesign the producer/reconciler contract. **Consume, never fork** — every new concept
reuses an existing canonical vocabulary rather than inventing a parallel one.

### 1. The manifest is the existing CI check registry, not a new file

`evals/ci/run-baseline.sh` already defines a CI-verified, named, individually-re-runnable
command registry: the `CHECKS` array of `"Label|command"` pairs, partitioned into `LANE_*`
arrays that `.github/workflows/ci.yml`'s jobs invoke via `--check <slug>`. The merge-gating
lanes (`LANE_SOURCE_AND_STATIC`, `LANE_WORKFLOW_CONTRACTS`, `LANE_RUNTIME_AND_KIT`) are
*structurally* wired into a required job — the anti-gaming property ("a manifest command must
actually run in a required lane") is achieved **by construction** rather than by a new rule
that itself needs policing. The advisory `LANE_USAGE_FEEDBACK` lane runs `continue-on-error`
and does **not** gate a merge, so its checks are **excluded** from `--manifest-json`: a
`test_output` claim must never be able to reconcile against a non-gating command.
(`test_trust_reconcile_manifest.sh` asserts the emitted manifest equals the *required-lane*
`--check` set, usage-feedback excluded from both sides.)

`run-baseline.sh` gains a machine-readable `--manifest-json` emit mode (lane-covered checks
only, as `{id, command, lanes[]}`). `trust-reconcile.js` gains a manifest resolver with the
priority order:

1. CLI `--manifest <json>`
2. env `TRUST_RECONCILE_MANIFEST <json>`
3. `package.json "trust-reconcile-manifest"` — an inline `{id, command}[]` array (for
   adopters without a `run-baseline.sh`-shaped registry), **or** a string command that
   emits that JSON. This repo declares it as `bash evals/ci/run-baseline.sh
   --manifest-json`, so its live manifest *is* the run-baseline registry.
4. `evals/ci/run-baseline.sh --manifest-json` (auto-detected — this repo's dogfood path).
5. Legacy fallback: the resolved single fresh-verify command(s) as a manifest of size N —
   so the historical single-command behavior is a strict subset (backward compat by
   construction).

The standalone fresh-verify (Step 1, the anchor's own independent CI truth) is unchanged.
The manifest governs Step 2 (per-command reconcile): a `test_output` claim may reconcile
only against a manifest command, and a manifest command not already run in Step 1 is
re-run **fresh on demand** (bounded by the registry) so the reconcile is against real CI
results, never the agent's self-report.

### 2. Claim classification reuses Surface's `evidenceType`/`method`, not a new taxonomy

`@kontourai/surface`'s `evidence.schema.json` already defines
`evidenceType: [source_excerpt, test_output, human_attestation, attestation,
calculation_trace, document_citation, crawl_observation, policy_rule]` and a `method`
enum. `buildTrustBundle` now derives `evidenceType`/`method` from `check.kind`:

| `check.kind` | `evidenceType` | `method` | reconcilable? |
| --- | --- | --- | --- |
| build, types, lint, test, command | `test_output` | `validation` | yes |
| security (command-backed) | `test_output` | `validation` | yes |
| security (no command) | `attestation` | `corroboration` | no |
| browser (command-backed) | `test_output` | `validation` | yes |
| browser (no command) | `crawl_observation` | `observation` | no |
| runtime (command-backed) | `test_output` | `validation` | yes |
| runtime (no command) | `attestation` | `attestation` | no |
| diff | `source_excerpt` | `extraction` | no |
| policy | `policy_rule` | `auditability` | no |
| external | `attestation` | `corroboration` | no |

A command-backed check now **always** carries `execution.label` (even when the local
command-log capture did not run it) so the reconciler has a stable match key. A claim is
**reconcilable** iff its evidence is `evidenceType: "test_output"` **and** its command
matches a manifest entry; everything else is **session-local by construction** — no new
boolean, no new enum. A `test_output` claim whose command is *not* in the manifest is
still a divergence (an agent cannot self-label an arbitrary command `test_output` to dodge
the manifest). The existing exit-code-laundering check runs *before* classification and is
unchanged.

**Iteration-2 hardening (soundness fixes found in review).**

- **A `test_output` claim reconciles or it is a divergence — never session-local (finding 1).**
  The not-run guard triggers for ANY pass-asserting claim whose evidence is
  `evidenceType: test_output` (Surface's default when unset) that lacks a manifest-matched
  `execution.label` — not only the literal claimType `workflow.check.command`. A fabricated
  `kind:"test"` claim with no command still emits `test_output` evidence with no label; it is
  now a `not-run` divergence instead of silently passing as session-local.
- **The reconciler re-derives status CI-side and never trusts `claim.status` (finding 3).**
  For every session-local claim, `trust-reconcile.js` re-runs Surface's canonical
  `deriveClaimStatus` over the bundle's OWN evidence/events/policies (via
  `scripts/ci/derive-claim-status.mjs`, resolving Surface from the anchor's own node_modules)
  and compares the result to the asserted status. A mismatch is a `status-misassertion`
  divergence; if re-derivation is unavailable the claim fails closed (`status-underivable`).
  The bundle's self-reported `status` field is never the basis for a pass.
- **Policy construction is order-independent (AC1 cache defect).** `ensurePolicy` keys its
  cache by `(claimType, requiredEvidence)` rather than by `claimType` alone, so two checks of
  the same legacy claimType that differ in command-presence (a command-backed browser check →
  `test_output` vs a no-command browser check → `crawl_observation`) get distinct policies
  instead of the first-seen `requiredEvidence` silently corrupting the second claim's derived
  status. Merging is deliberately NOT used — Surface's `requiredEvidence` is all-of, so a union
  would over-constrain both claims. `trust-bundle-policy-order.test.mjs` proves two same-kind
  checks produce identical bundles in both record orders.

### 3. Waivers reuse the existing `accepted_gap` status

`record-evidence`/`record-gate-claim` gain `--accepted-gap-reason <text>` and `--waived-by
<actor>` (both required together — an accepted gap with no justification or no approver is
refused; no silent/default waiver). When present, the recorded claim is classified
session-local (`attestation`), its status is the existing `accepted_gap → assumed` mapping,
and `claim.metadata.waiver = {reason, approved_by, approved_at}` is stamped
(`claim.metadata` is free-form per `claim.schema.json` — no schema fork). The reconciler
prints every waived claim on a distinct, un-suppressible `[trust-reconcile] WAIVED: ...`
line so it is visible in the required job's own log — reviewed, justified, never silent.

A session-local claim that is **not** waived must resolve a real, CI-RE-DERIVED `verified`
status to pass; a `disputed`/`rejected` claim still blocks. **`assumed` alone is no longer a
silent pass (finding 2):** because the `skip → assumed` mapping means an unjustified skip
resolves `assumed`, an `assumed` claim is accepted ONLY when it also carries a waiver (printed
on the loud `WAIVED` line). An unwaived `assumed` claim is an `unwaived-assumed` divergence —
restoring the pre-WS8 semantics where `assumed` alone never satisfied a claimed pass. An
unwaived session-local claim asserting pass without a re-derived `verified` status is an
`unwaived-session-local` divergence. Session-local classification is **not** a pass bypass.

**A command-backed check cannot be waived (finding 4).** A waiver documents an *accepted gap*
in something that was not re-runnably verified; a `test_output` (command-backed) check
reconciles against CI or fails, so waiving it would let an agent skip the real run. Both the
producer (`record-evidence`/`record-gate-claim` reject `--accepted-gap-reason`/`--waived-by`
on any check whose evidence classifies as `test_output`) and the reconciler (a waiver on a
claim backed by `test_output` evidence is a `waiver-on-command-check` divergence) enforce this.

**Authority-binding residual (honest).** `approved_by` is currently free text — the reconciler
verifies a waiver is *present, justified, and named*, and prints it loudly for human review,
but it does NOT yet cryptographically bind the approver to an authenticated identity. Tying
`approved_by` to an Assurance-profile identity (Surface's authority/identity model), so a
waiver's approver is verifiable rather than self-asserted, is deferred to that profile's
adoption and tracked as follow-up; until then a waiver's accountability rests on the required
job's visible `WAIVED` line and CODEOWNERS review, not on identity attestation. (See Residuals
below — this is the same authenticated-identity gap that also underlies the fabricated-
attestation residual.)

### 4. Iteration-4 hardening: loud disclosure of non-command-backed passes (converged finding)

Both iteration-3 gates (the review critique and an independently-corroborating adversarial
re-verification) converged on one finding against the redesign above: a session-local claim
that re-derives `verified` with **no waiver** — i.e. every `human_attestation` / `attestation`
/ `external`-evidenced claim for a no-`command` check (§2's table: `security`/`browser`/
`runtime`/`external` without a command, `diff`, `policy`) — was printed as a quiet
`SESSION-LOCAL OK` line, identical in weight and format to a genuinely CI-reconciled
`RECONCILED` line. `deriveClaimStatus` (finding 3, §"Iteration-2 hardening") re-derives status
from the bundle's OWN evidence/events/policies — it proves the bundle is **internally
self-consistent**, never that the underlying real-world attestation is **true**. A fully
hand-fabricated claim+evidence+event triple (a single `record-evidence --check-json
'{"kind":"security","status":"pass",...}'` call with no `command` field, run through the real
producer CLI) is, at this re-derivation layer, indistinguishable from a genuine one — and
because pre-WS8 every check was hardcoded `test_output` (§ Context, point 2), this specific
silent-pass path did not exist before this redesign; WS8 newly opened it for exactly the
high-impact, no-command kinds this ADR added first-class support for.

The fix is **disclosure, not a new block**: blocking every non-command-backed claim at this
layer would break every honest human-attestation/external-check use the manifest+
classification redesign exists to support (§1–§2's whole point). Instead, `trust-reconcile.js`
now prints every such claim on a loud, distinct, `grep`-stable line —

```
[trust-reconcile] ATTESTED (not independently verifiable at L0): '<claimId>' (<claimType>) evidenceType=<type> — accepted on bundle-internal consistency only; see ADR 0020 Residuals
```

— and a summary count after the reconcile step (`N attested claim(s) accepted without
independent verification`), always emitted (including `0`) so its absence is never mistaken
for "count line not implemented." Exit codes are unchanged — this is visibility, not a new
gate. `evals/integration/test_trust_reconcile_negatives.sh` freezes a fabricated-attestation
fixture asserting BOTH the pass (exit 0) AND the loud marker + summary line, and
`test_trust_reconcile_mixed_bundle.sh`'s shipped honest bundle asserts its own `ATTESTED` line
so the honest path is proven, not just the exploit.

## Residuals (honest — ADR 0017 §Residuals style; a bar-raiser, not a wall)

- **Fabricated self-consistent attestation bundles pass, loudly marked (inherent to L0).**
  "L0" here means this reconciler's baseline reconcile/re-derivation layer — distinct from
  ADR 0017's Layer 1–4 defense-in-depth naming. At L0, a non-command-backed claim
  (`human_attestation`/`attestation`/`external`/etc.) can only be checked for *internal*
  self-consistency (does the bundle's own evidence/event agree with the asserted status);
  L0 has no independent oracle for whether the underlying real-world review/attestation
  actually happened. A hand-fabricated bundle that is internally consistent therefore passes
  — by design, since L0 cannot tell it apart from a genuine one. **The remedy is a higher
  Assurance profile, not a stronger L0 heuristic:** an L1/L2 profile in which
  non-command-backed evidence is cryptographically signed by an authenticated identity at
  capture time (extending Layer 3's keyless-Sigstore minting, ADR 0017, from CI's own fresh
  results to individual human-attestation events) would let the reconciler verify the
  attestation's *provenance*, not merely the bundle's internal arithmetic. That profile does
  not exist yet; until it does, every `ATTESTED` line is this ADR's explicit, permanent
  disclosure that the claim rests on bundle-internal consistency only — a human reviewer,
  not the reconciler, is the check.
- **Free-text `approved_by` on waivers is unauthenticated (existing disclosure, folded in
  here).** As noted in §3 above: a waiver's `approved_by` is self-asserted free text, not
  bound to an authenticated identity. *Mitigated by:* the loud, un-suppressible `WAIVED` line
  in the required job's own log, plus CODEOWNERS review — not by identity attestation. Same
  underlying gap and same Assurance-profile remedy as the attestation residual above.
- **The evidenceType-laundering route (explicitly named).** §2's classification table routes
  `security`/`browser`/`runtime` checks to `test_output` (CI-reconcilable) only `hasCommand`;
  otherwise they fall to `attestation`/`crawl_observation` (session-local). An agent that
  wants a high-impact check to avoid CI re-execution can simply omit `command` from the
  `record-evidence --check-json` call — the check is not "downgraded," it legitimately *is*
  session-local (no command to reconcile), but the practical effect is the same evasion
  surface as the fabricated-attestation residual above: a `kind:"security"`/`"runtime"`/
  `"external"` claim with no command was, pre-iteration-4, indistinguishable from a
  test_output-equivalent pass. *Mitigated by:* the iteration-4 `ATTESTED` marker makes every
  claim that took this route visible and countable in the required job's own log — a reviewer
  (or a future CI policy keyed on the summary count) can now see exactly how many high-impact
  claims in a passing bundle went through the no-command/session-local path rather than a
  fresh CI re-run. Not closed; disclosed. Closing it fully requires either (a) the
  Assurance-profile signing remedy above, or (b) a policy decision to require `command` for
  specific `impactLevel`/`kind` combinations (a future, separate ADR — not implemented here,
  as it would need to weigh against the honest no-command use cases §1–§2 exist to support).

The consistent principle (same as ADR 0017): **the reconciler's L0 baseline cannot manufacture
independent truth for non-command-backed evidence; disclosure (the loud `ATTESTED` marker +
summary count) and human review are the closing mechanism until a signed-attestation
Assurance profile exists.**

## Consequences

- The exact capability PR #264 lacked now exists and is proven end-to-end:
  `evals/integration/test_trust_reconcile_mixed_bundle.sh` builds a bundle with one
  manifest-matched `test_output` claim, one honest `human_attestation` session-local claim,
  and one waived `accepted_gap` claim, and passes the *real* `trust-reconcile.js`
  entrypoint (exit 0) with distinct `RECONCILED` / `ATTESTED (not independently verifiable at
  L0)` / `WAIVED` lines (the `SESSION-LOCAL OK` line from earlier iterations was replaced by
  the loud `ATTESTED` marker in iteration-4 — see §4 above).
- The anti-gaming self-check `evals/integration/test_trust_reconcile_manifest.sh` asserts
  the manifest id set and ci.yml's required `--check` set are identical, and runs in a
  required lane (`antigaming-suite.sh`). Removing a check from every `LANE_*` array fails
  it.
- Every live exploit reproduced in review is frozen as a permanent negative regression in
  `evals/integration/test_trust_reconcile_negatives.sh` (wired into the required
  `antigaming-suite.sh`): a no-label `test_output` bypass, a `skip → assumed` silent pass, a
  `status-misassertion`, a waived command-backed check, the real ws3 old-style bundle
  (AC6), and (iteration-4) a fabricated-attestation bundle asserting it PASSES (exit 0) while
  emitting the loud `ATTESTED` marker and summary count — a visibility assertion, not a
  divergence assertion — each of the first five asserting a non-zero exit and its specific
  divergence string.
- Backward compat holds by construction: single-command adopters and old all-`test_output`
  bundles reconcile identically (the legacy path is a manifest of size 1). The existing
  laundering, checkpoint-bypass, and never-captured-command divergences are unchanged.
- CODEOWNERS protection extends to the new `trust-reconcile-manifest` declaration, matching
  ADR 0017's owner-review posture for the verify config.
- **Trade-off (honest):** the reconciler re-runs matched manifest commands fresh on demand.
  This is bounded by the registry and only the claimed commands are run. Reusing ci.yml's
  already-produced `status.tsv` (rather than re-running) is a future optimization the
  manifest design anticipates but this ADR does not implement.

## Alternatives Considered

- **A new manifest file / a new `claimType` taxonomy / a new waiver status value** — all
  rejected as forks of existing canonical vocabulary (`run-baseline.sh`'s registry,
  Surface's `evidenceType`, the `accepted_gap` status). Each would create a parallel
  concept needing its own policing.
- **Making the reconciler re-run the full registry in `trust-reconcile.yml`** — rejected:
  it would duplicate the entire ci.yml suite in a second required job. On-demand fresh runs
  of only the claimed manifest commands give the same soundness at bounded cost.
