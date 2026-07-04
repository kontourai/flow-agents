---
title: "ADR 0022: Fail-Closed Delivery Reconciliation with Governed Exemptions"
---

> **FROZEN — immutable history.** Superseding/current decisions live in [`docs/decisions/`](../decisions/index.md). Do not edit.

# ADR 0022: Fail-Closed Delivery Reconciliation with Governed Exemptions

**Date:** 2026-07-02
**Status:** Proposed (shaped with Brian Anderson, 2026-07-02). Refines the Layer-2 CI
anchor established in [ADR 0017](./0017-anti-gaming-trust-security-model.md) and hardened in
[ADR 0020](./0020-trust-reconcile-manifest-and-claim-classification.md); does not change
their layered-defense posture.

---

## Context

`scripts/ci/trust-reconcile.js` — the external CI trust anchor ADR 0017 designed as the
un-forgeable Layer-2 boundary — has run **fail-open on bundle absence** since it existed. Its
own header states the behavior plainly:

> "Fail-open on bundle absence: if no bundle is provided (and none auto-discovered at
> `delivery/trust.bundle` or `delivery/trust.checkpoint.json`), only the fresh verify is
> enforced."

`discoverBundle()` (trust-reconcile.js:461-470) returns `null` when neither file exists, and
`runTrustReconcile()` (trust-reconcile.js:529-533) treats `null` as "Step 2 does not apply" —
Step 1 (fresh `npm run build && npm run eval:static`) still runs, but the actual anti-gaming
machinery ADR 0017/0020 built — reconciling claimed-pass commands, catching laundering,
catching never-captured claims, catching status-misassertion — never engages. The bundle is
also **fail-soft to produce**: `publishDelivery()` (`src/cli/workflow-sidecar.ts`, documented
in `delivery/README.md`) "does nothing if `trust.bundle` is absent (no crash, no error)." So
the single condition that turns Layer 2 on or off — whether a bundle exists in the diff — is
entirely under the delivering agent's control, and skipping it costs nothing and raises no
alarm.

That is a **kill switch by omission**: the agent, not an external anchor, decides whether the
anchor applies. This directly contradicts ADR 0017's own threat model ("no purely-local
control is airtight; the authoritative anchor must live somewhere the agent cannot
pre-disable or post-forge") — except here the "pre-disable" move is not a local hack at all,
it is simply *not delivering the artifact CI depends on to reconcile*, and CI accepts that
silently.

The historical record makes the exposure concrete, not theoretical: every PR before #265
passed the Trust Reconcile lane trivially via bundle absence (`git log --follow --
delivery/trust.bundle` shows the file's first appearance at #269, "veritas-governance kit —
readiness→trust-bundle adapter with settled gate semantics" — the first live,
capture-backed publish this repository ever produced). For roughly the entire history of the
anchor, Layer 2 has been running Step 1 only.

## Decision

### 1. The predicate: every change is agent-delivered by default; identification signals inform, never gate

Research into how agent-delivered changes are identifiable today turned up three candidate
signals, and all three share the same flaw: **they are agent-writable, agent-omittable, or
both.**

| Signal | Where it lives | What it proves when present | Why it cannot gate alone |
|---|---|---|---|
| Runtime-session commit trailer (`Claude-Session: https://claude.ai/code/session_...`, and the analogous `Codex-Session:` / `Opencode-Session:` / `Pi-Session:` forms implied by the same runtime set the actor-identity resolver already enumerates, `scripts/hooks/lib/actor-identity.js:58-65` `RUNTIME_SESSION_ID_VARS`) | Free text the agent appends to its own commit message | Positive proof of agent delivery, attributable to a runtime/session | Purely self-asserted; an agent that wants to hide simply omits the trailer. No repo code enforces its presence today — it is observed convention (present on essentially every recent merged PR per `git log`), not a contract. |
| `delivery/trust.bundle` / `trust.checkpoint.json` present in the diff | Committed transport path (`delivery/README.md`) | Positive proof of agent delivery (only `publishDelivery()` writes these) | This is the exact signal already in play — its **absence** is today's loophole. Trusting presence-only leaves absence exactly as exploitable as it is now. |
| A "required marker" naming the delivering agent | Does not exist today | Would prove delivery mechanism | Nothing in the codebase currently stamps a required, non-omittable, non-agent-writable marker of agent origin. |

No positive-detection signal can be the enforcement gate, because closing a gap that an agent
controls by omission with *another* agent-controlled, omittable signal reproduces the same
bug one layer up. The predicate therefore **inverts**: reconciliation applies to every change
by default. The three signals above are retained as **diagnostic and audit inputs only** —
they explain and attribute what the anchor already treats as agent-delivered; they do not
decide whether it treats it that way. Concretely, per signal:

1. **Commit trailer present** — logged by the reconciler (new `[trust-reconcile] identified:
   runtime-session trailer '<trailer>' on <ref>` line) for audit; does not change the exit
   path. Reconciliation already applies (default).
2. **`delivery/trust.bundle` present** — unchanged from today: Step 2's existing
   reconcile-against-manifest logic (ADR 0020) runs exactly as it does now.
3. **Neither present (today's common "nothing shipped" case, indistinguishable from a
   legitimate human-only PR)** — this is the ambiguous case, and it is the one the fail-open
   bug lived in. It now resolves to **agent-delivered, fail closed**: `trust-reconcile.js`'s
   bundle-absence branch gains a new check — is there a well-formed DECLARED marker (§2) in
   scope for this ref? No → **new divergence type**, `bundle-required-no-declared-marker`,
   job exits 1. Yes → exempted, see below.
4. **Malformed DECLARED marker** (missing any of the four required fields, §2) — treated as
   absent; falls through to case 3's fail-closed default, with a diagnostic naming the
   missing field(s) so a human fixing it does not have to guess the schema.

### 2. The DECLARED no-agent-delivery marker

Humans and other legitimate non-agent changes (release-automation bots, direct maintainer
pushes) opt out via a committed `delivery/DECLARED` JSON file — the same `delivery/`
transport path `trust.bundle` already uses, so the anchor gains exactly one new
auto-discovery target, not a new mechanism:

```json
{
  "scope": "ref:release-please--branches--main",
  "reason": "release-please automation PR; no agent delivery involved",
  "approved_by": "briananderson1222",
  "declared_at": "2026-07-02T00:00:00Z"
}
```

All four fields are required for "well-formed." `scope` matches either a single ref/commit
range or a durable pattern (author or branch-prefix match — see Consequences for why this
matters for bot PRs). Presence and content are printed **loudly**, mirroring ADR 0020's
`WAIVED:` convention exactly:

```
[trust-reconcile] DECLARED (no-agent-delivery): <scope> — <reason> (approved by <approved_by>, declared <declared_at>)
```

A DECLARED marker exempts **Step 2 only** (bundle-required enforcement). Step 1 (fresh
verify) is never exempted by anything in this ADR — a human PR still has to build and pass
static evals; only the anti-gaming reconcile step, which presumes an agent-produced bundle
to reconcile against, is skippable, and only with attribution.

`delivery/DECLARED` is added to `.github/CODEOWNERS` alongside the other verify-config and
anchor paths (`/scripts/ci/`, `/package.json`, `/evals/run.sh`) it already lists — the same
mitigation ADR 0017 Layer 4 uses for every other self-asserted, unauthenticated field
(`approved_by` on a waiver has the identical shape and the identical residual; carried over
here rather than re-solved).

### 3. Layering: the governance kit issues and audits; the anchor enforces

Per ADR 0017's own framing ("kits declare process; the anchor enforces"), exemption
*issuance* and *audit* — the human-approval workflow, not the enforcement decision — belong
in `kits/veritas-governance`, the kit this repository already stood up (#269, migrated #285)
for exactly this class of "turn a governance verdict into gate evidence" concern. It ships
today as a single flow/single gate (`flows/readiness-check.flow.json`: step `readiness` →
gate `gate-check-gate`, requiring a verified `software-readiness-verdict` trust.bundle
claim). This ADR specifies a second flow of the identical shape:

- **`flows/exemption-issuance.flow.json`** — agentless, K0, mirroring
  `readiness-check.flow.json`'s structure: step `request` → gate `human-approval-gate`
  (`expects` a trust.bundle claim of `claimType: "no-agent-delivery-exemption-approval"`,
  `subjectType: "delivery-scope"`, `accepted_statuses: ["verified"]` — satisfiable only by
  human-attached evidence, the same pattern `gate-check-gate` uses for the readiness verdict)
  → step `issue`, which writes the resulting `delivery/DECLARED` file once the gate passes.
- **`exemption-usage-review`** — a periodic audit skill/flow that walks
  `delivery/DECLARED` history (`git log --follow -- delivery/DECLARED`) merged in a review
  window and surfaces every standing exemption (scope, reason, approver, age) for owner
  re-confirmation — process visibility, not enforcement.

The load-bearing property: **uninstalling `veritas-governance` must never weaken
enforcement.** `trust-reconcile.js`'s marker-reading logic — auto-discover
`delivery/DECLARED`, require all four fields, print the DECLARED line, exempt Step 2 only —
lives in `scripts/ci/` (already CODEOWNERS-protected, already anchor-owned) and has zero
runtime dependency on the kit. A human can hand-author a compliant `delivery/DECLARED`
without the kit installed; they simply lose the guided issuance flow and the periodic-review
tooling. This is the concrete test of the layering claim, not just its statement.

### 4. Breaking change — no legacy fallback

This changes the exit code of every future agent-delivered change (which, under the inverted
default, is every change unless explicitly DECLARED otherwise) that does not ship a
`delivery/trust.bundle`. There is no flag, no grace window, no opt-in period — matching the
owner's explicit direction to document this as a breaking change rather than carry a legacy
fail-open path indefinitely. Concretely:

- Any PR that today merges by passing Trust Reconcile "trivially via absence" starts failing
  the moment this ships, until it either (a) publishes a bundle via the existing
  `publishDelivery()` path, or (b) carries a DECLARED marker in scope.
- **Repos consuming `.github/workflows/trust-reconcile.yml` as a template** (ADR 0017 §
  Consequences names this the intended reuse path) must pin to the pre-ADR-0022 commit until
  ready, then adopt in one migration PR that either wires bundle publication into their
  delivery flow or authors an initial `delivery/DECLARED` covering their known non-agent
  actors (see Consequences below for the concrete bot case).

## Scope boundaries

**`hasBuild` fail-open in `stop-goal-fit.js` (line 185; `loadActiveFlowStep`,
lines 305-316) is the same absence-controls-enforcement asymmetry in miniature — it is
explicitly out of scope for this ADR.** One-line rationale: it is a Layer-1, local,
**non-authoritative** fallback (its own comment: "Fail-open: returns null when build/ is
absent... the caller treats null as 'no active FlowDefinition' and falls back to the
`workflow.*` path") — Layer-1 heuristics were explicitly frozen by
[ADR 0018](./0018-freeze-local-shell-heuristics.md), which routes *all* new enforcement
concerns to the external anchor rather than adding local surface. This ADR *is* that
external-anchor hardening; extending the local `hasBuild` check would both violate the
freeze and buy nothing, since a determined agent controls its own local `build/` presence
regardless of what the local heuristic does. Cross-ref: ADR 0017 §Layer 1 vs Layer 2;
ADR 0018 §Decision.

## Residuals (honest — ADR 0017 §Residuals / ADR 0020 §Residuals style; a bar-raiser, not a wall)

- **Forged human attribution.** `approved_by` on `delivery/DECLARED` is free text, not bound
  to an authenticated identity — the identical residual ADR 0020 already carries for
  `WAIVED`'s `approved_by`, and the identical mitigation: the loud, un-suppressible DECLARED
  line plus CODEOWNERS review, not identity attestation. Not solved here; explicitly
  inherited.
- **Shared credentials collapse the human/agent distinction.** An agent operating under
  commit/push rights indistinguishable from a human collaborator (a shared PAT, a service
  account with CODEOWNERS review rights) can author and approve its own DECLARED marker. This
  is ADR 0017's already-named "trust-the-humans boundary... documented, not closed" —
  unchanged by this ADR.
- **Identification signals undercount, they do not overcount.** Because the enforcement
  default no longer depends on the commit-trailer or delivery-artifact signals (§1), an agent
  can still freely omit both. Any future audit tooling built on those signals ("which PRs
  were agent-delivered") will therefore undercount attribution — this ADR fixes the
  enforcement default, not attribution completeness.
- **CI checkout depth limits trailer detection today.** `trust-reconcile.yml`'s
  `actions/checkout` step does not currently widen fetch depth to cover a PR's full commit
  range, so the commit-trailer diagnostic in §1's table is aspirational for CI-side logging
  until checkout is widened. This does not block the ADR: the trailer is diagnostic-only,
  never gating, per §1.
- **Bot/automation PRs need a durable, not per-PR, DECLARED scope**, or every dependabot /
  release-please PR starts failing the moment this ships (see Consequences). `scope`
  supports author/branch-pattern matching for exactly this reason, but the pattern-matching
  logic itself is new surface this ADR specifies and a future implementation must get right;
  a narrow pattern match is itself a residual surface (a scope pattern that is too broad
  re-opens a blanket exemption).

## Consequences

- Trust Reconcile stops being satisfiable by doing nothing. The anti-gaming machinery ADR
  0017/0020 built (reconcile, laundering screen, status re-derivation, `ATTESTED`/`WAIVED`
  disclosure) now actually runs on every agent-delivered change by default, closing the gap
  the historical record (`delivery/trust.bundle`'s first appearance at #269) shows has been
  open for the anchor's entire prior history.
- **`dependabot.yml` and `release-please.yml`-authored PRs** (both present in this repo's
  `.github/`) will start failing Trust Reconcile the moment this ships unless a durable,
  author/branch-scoped `delivery/DECLARED` marker is authored for each before rollout — a
  concrete, non-hypothetical migration item, not a theoretical edge case.
- `veritas-governance` gains a second flow and a periodic-review surface; its "unverified,
  not first-party-allowlisted" trust status (per its own README) is unaffected by this ADR —
  the anchor-side enforcement this ADR specifies works whether or not the kit is installed.
- `.github/CODEOWNERS` gains one new protected path (`/delivery/DECLARED` or a `/delivery/`
  pattern narrow enough to exclude `trust.bundle`/`trust.checkpoint*`, which remain
  agent-written).
- Downstream repos treating `trust-reconcile.yml` as a template inherit a breaking change on
  adoption, not a gradual one — flagged explicitly per the owner's direction (§ Decision 4).

## Alternatives Considered

- **Positive-detection predicate (trust the commit trailer or bundle presence as the sole
  signal).** Rejected in §1: any agent-writable/omittable positive signal reproduces the
  fail-open bug at one remove — an agent that wants to evade omits the signal being checked,
  exactly as it omits the bundle today.
- **Extend `hasBuild` / Layer-1 heuristics to close the analogous gap locally.** Rejected —
  violates the ADR 0018 freeze and cannot be authoritative regardless (Scope boundaries,
  above); the correct fix lives in Layer 2, which is what this ADR does.
- **Grace period / opt-in flag before flipping the default.** Rejected per the owner's
  explicit direction: document as a breaking change, do not carry a legacy fail-open path.
- **Require cryptographic (Sigstore-signed) attribution for the DECLARED marker instead of
  free-text `approved_by`.** Deferred, not rejected — this is exactly the Assurance-profile
  remedy ADR 0020's Residuals names for the identical `WAIVED` gap ("extending Layer 3's
  keyless-Sigstore minting... to individual human-attestation events"). It does not exist yet
  for waivers; inventing it first for DECLARED markers alone would be inconsistent scope.
  When/if that Assurance profile lands, both `WAIVED` and `DECLARED` should adopt it together.
- **Put exemption enforcement inside `veritas-governance` itself (kit owns both issuance and
  enforcement).** Rejected — this is precisely the layering ADR 0017 already establishes
  ("kits declare process; the anchor enforces") and the explicit requirement that uninstalling
  a kit must never weaken enforcement; enforcement logic must live anchor-side regardless of
  which kit (if any) is installed.

## References

- [ADR 0017: The Anti-Gaming Trust Security Model](./0017-anti-gaming-trust-security-model.md)
  — the layered defense this ADR refines Layer 2 of; the threat-model framing ("no purely-local
  control is airtight") this ADR's problem statement is a direct instance of.
- [ADR 0018: Freeze the Local Shell-Parsing Heuristics](./0018-freeze-local-shell-heuristics.md)
  — the freeze that puts the `hasBuild` miniature explicitly out of scope and routes this
  ADR's fix to the external anchor instead.
- [ADR 0020: Trust-Reconcile Manifest, Claim Classification, and Waivers](./0020-trust-reconcile-manifest-and-claim-classification.md)
  — the `WAIVED`/`ATTESTED` disclosure conventions this ADR's `DECLARED` marker mirrors; its
  Residuals section (`approved_by` unauthenticated, mitigated by CODEOWNERS + the loud log
  line) is inherited verbatim for `DECLARED`.
- `scripts/ci/trust-reconcile.js` (`discoverBundle`, lines 461-470; `runTrustReconcile`
  bundle-absence branch, lines 529-533) — the code this ADR changes.
- `src/cli/workflow-sidecar.ts` `publishDelivery()` / `delivery/README.md` — confirms the
  bundle is fail-soft to produce today, the root of the omission loophole.
- `scripts/hooks/lib/actor-identity.js` (`RUNTIME_SESSION_ID_VARS`, lines 58-65) — the
  runtime enumeration the commit-trailer signal's naming is grounded in.
- `scripts/hooks/stop-goal-fit.js` (`hasBuild`, line 185; `loadActiveFlowStep`, lines
  305-316) — the Layer-1 miniature explicitly scoped out.
- `kits/veritas-governance/` (`kit.json`, `flows/readiness-check.flow.json`,
  `docs/README.md`) — the existing kit shape §3's `exemption-issuance.flow.json` mirrors.
- `.github/CODEOWNERS` — the existing self-asserted-field mitigation pattern extended to
  `delivery/DECLARED`.
- `.github/dependabot.yml`, `.github/workflows/release-please.yml` — the concrete bot-PR
  migration case named in Consequences.
- #274 — the issue this ADR resolves; #269 — the first live capture-backed bundle publish
  cited in Context; #265 — the last PR to merge before that (i.e. the boundary of "every PR
  before #265 passed Trust Reconcile trivially via absence").

## Addendum (2026-07-03): compound `scope` (space-separated AND) — security-review hardening

A security review of the #300 implementation found that `ref:`/`branch-prefix:` scope
conditions match against `GITHUB_HEAD_REF` (or the `TRUST_RECONCILE_REF` override), and on a
**fork PR `GITHUB_HEAD_REF` is pusher-controlled** — any contributor who can open a PR can
name their branch to satisfy a `ref:`- or `branch-prefix:`-only scope. A `delivery/DECLARED`
entry written to exempt one specific bot (e.g. `ref:release-please--branches--main`) is
therefore satisfiable by anyone who pushes a branch with that exact name, not only by the
automation it names. `author:` (bound to the platform-set `GITHUB_ACTOR`, not attacker-chosen
in the same way) does not have this weakness alone, but a single `author:` condition cannot
express "and also narrow the blast radius to this branch pattern" — the two properties needed
combining, not substituting for each other.

**Decision:** `scope` may contain multiple space-separated conditions, each one of the four
forms specified in §2 (`ref:`, `commit:`/`commit:a..b`, `author:`, `branch-prefix:`); a
compound scope matches only if **every** condition matches (AND, not OR). A single-condition
scope is unchanged and remains valid (backward compatible — it is the N=1 case of the same
rule). Matching is still string equality/prefix only, per condition — no `RegExp` is
constructed from marker content in either the single- or compound-condition path. An
unrecognized-prefix condition anywhere in a compound scope makes the **whole** scope never
match, the same fail-closed behavior a malformed single-condition scope already had.

**`ref:`/`branch-prefix:` alone are insufficient for identity exemptions and MUST be combined
with `author:`.** Per the finding above, a scope meant to identify a specific bot/automation
actor (as opposed to a specific commit range or branch, where the identity question does not
arise) should not rely on `ref:`/`branch-prefix:` in isolation — combine it with `author:` so
the platform-set actor identity, not just a self-chosen branch name, has to match too. The
migration marker this ADR's Consequences named for release-please is updated accordingly:

```json
{
  "scope": "author:github-actions[bot] branch-prefix:release-please--",
  "reason": "release-please automation PR; no agent delivery involved",
  "approved_by": "briananderson1222",
  "declared_at": "<ISO timestamp>"
}
```

(`dependabot[bot]`'s entry, `author:dependabot[bot]`, was already a single `author:` condition
— security-review-confirmed sound as-is and left unchanged.)

**`/delivery/DECLARED` CODEOWNERS landed with #300/#301.** `.github/CODEOWNERS` now lists
`/delivery/DECLARED` under the same owner as `/scripts/ci/`, `/package.json`, and
`/evals/run.sh` (§2's original intent, made concrete); `evals/static/test_flowdef_codeowners_coverage.sh`
carries a regression-lock assertion for the entry. This closes the file-level half of #301;
server-side enforcement of CODEOWNERS review on `main` remains tracked separately (#225).

## Addendum (2026-07-03, part 2): bundle-ownership staleness check — "for THIS change"

Owner-approved follow-up to the compound-scope addendum above, closing a second gap the same
security review surfaced, this time against a **live incident**: PR #278 (the same open
dependabot PR cited in Baseline/Consequences) carries a `delivery/trust.checkpoint.json`
inherited byte-for-byte from `main` (dependabot never runs the deliver skill on its own
branch — the file only exists there because `main`'s tree already had it). Prior to this
addendum, `discoverBundle()` finding *any* file at `delivery/trust.bundle` or
`delivery/trust.checkpoint.json` — regardless of whether it says anything about the change
actually being reconciled — was sufficient to route into Step 2. A stale, inherited
checkpoint from a completely unrelated prior PR would therefore either (a) reconcile
against claims/evidence that have nothing to do with the current diff (if it were a full
`trust.bundle`), or (b), as in the checkpoint-only case, hit the existing
`checkpoint-bypass` divergence — **coincidentally fail-closed today only because a bare
checkpoint has no `evidence[]`/`claims[]` to reconcile**, not because the reconciler
recognized the file as stale. A future stale *full* `trust.bundle` (not just a checkpoint)
inherited the same way would not have that accidental protection.

**Decision:** "bundle-required" (ADR 0022 §1) means a bundle **for this change**, not any
bundle merely reachable at the checkout. `discoverBundle()`'s result is now checked against
a commit-identity binding before Step 2 is allowed to run against it:

- **Binding chosen:** `trust.checkpoint.json`'s `commit_sha` field (stamped by
  `sealTrustCheckpoint()` in `src/cli/workflow-sidecar.ts` from `git rev-parse HEAD` at seal
  time) — the strongest identity signal available today. `trust.bundle` itself carries no
  commit/branch metadata (schema: `{schemaVersion, source, claims, evidence, policies,
  events}` — confirmed by inspection), so when the auto-discovered file is `trust.bundle`,
  the check falls through to its sibling `delivery/trust.checkpoint.json` (same
  `resolveDeliveryCandidates()` seam; `publishDelivery()` always writes both together).
- **Match rule:** the bundle's `commit_sha` equals this change's own sha
  (`TRUST_RECONCILE_SHA`/`GITHUB_SHA`), OR is a git-ancestor of it, via the same `git
  merge-base --is-ancestor` primitive `commit:` scopes already use. Exact equality alone was
  considered and rejected: `sealTrustCheckpoint()` necessarily stamps a commit that precedes
  its own delivery commit (a checkpoint cannot contain its own future commit's sha), so
  requiring exact equality would reject every legitimately fresh delivery, not just stale
  ones. Ancestor-or-equal correctly accepts "sealed earlier in this same open PR's own
  linear history" while — because this repo squash-merges PRs into `main` — correctly
  rejecting a checkpoint inherited from `main`: a squash-merged commit's checkpoint records
  the pre-squash feature-branch tip as `commit_sha`, which is provably **not** an ancestor of
  any later branch (squash discards the original commit graph), so any checkpoint that ever
  lands on `main` becomes permanently unmatchable by a later, unrelated branch — exactly the
  PR #278 shape.
- **Fail closed on ambiguity:** no extractable `commit_sha` (missing from both the bundle and
  its sibling checkpoint), or this change's own sha unresolvable — never treated as owned. A
  stale/unowned bundle prints a loud, grep-stable line (`stale bundle ignored — attests
  <theirs>, this change is <ours>`) and is then treated exactly as if `discoverBundle()` had
  returned nothing: it falls through to `delivery/DECLARED` resolution.
- **Scope:** this check applies ONLY to **auto-discovered** bundles. An explicit
  `--bundle`/`TRUST_RECONCILE_BUNDLE` remains untouched — it is a deliberate caller choice
  (test fixtures, a programmatic caller passing a specific bundle), not something silently
  picked up from committed git tree state, and the real `.github/workflows/trust-reconcile.yml`
  never passes `--bundle`; it always relies on auto-discovery, which is exactly the path the
  incident went through.

**Residual, honestly named:** this binding is still self-reported (the checkpoint's own
`commit_sha`, not a cryptographic commit signature) and still only as strong as
`sealTrustCheckpoint()`'s local `git rev-parse HEAD` call — an adversarial agent that
controls its own local git state before delivery could, in principle, stamp an arbitrary
sha. This does not reopen the PR #278 gap (a human/bot PR that never runs the deliver skill
at all still cannot forge a checkpoint it never writes), but it is not a full defense against
a fully agent-controlled delivery pipeline; that class of residual is the same
"trust-the-humans boundary" ADR 0017/0020 already name, not newly introduced here.

## Addendum (2026-07-03, part 3): CI-context contract for the staleness check

A re-review found a launch-blocking gap in the staleness check (Addendum part 2, above):
`isAncestorCommit()`'s `git merge-base --is-ancestor` call is only meaningful if the CI
checkout actually has the parent commit objects, and if the sha compared against is a
commit a checkpoint could plausibly have been sealed at. Neither held under
`.github/workflows/trust-reconcile.yml`'s prior configuration: the default
`actions/checkout` fetch depth is a **shallow clone (`fetch-depth: 1`)**, which has no
parent objects — `git merge-base` against a missing object exits 128, so the ancestor
check would be unresolvable for every real PR, not just stale ones, falsely staling
**every legitimately fresh delivery** on a required, admin-enforced check. Separately, on
a `pull_request` trigger `GITHUB_SHA` resolves to GitHub's synthetic merge commit
(`refs/pull/N/merge`), a commit that never existed at the time any real `seal-checkpoint`
run stamped `commit_sha` — so even a correctly-resolving ancestor check would compare
against the wrong target. Both are now fixed at the workflow layer, not by loosening the
reconciler's own fail-closed contract: the checkout step sets `fetch-depth: 0` (full
history), and the trust-reconcile step sets `TRUST_RECONCILE_SHA:
${{ github.event.pull_request.head.sha || github.sha }}` so the ownership comparison
always uses the PR's own head commit on a `pull_request` trigger (falling back to
`github.sha`, which is already correct, on `push`/`workflow_dispatch`). The checkout ref
itself is unchanged — Step 1 (fresh verify) runs against the same tree it always has;
only the identity used for the Step-2 ownership comparison changes. This is a narrow,
deliberate, owner-recorded functional amendment to the "workflow YAML: comments only"
scoping the original Wave 1 plan set for this file — an unavoidable consequence of
closing the HIGH finding, not scope creep. `scripts/ci/trust-reconcile.js`'s own contract
is unchanged and stays fail-closed either way: a shallow/missing-object condition still
resolves to "not an ancestor" (never silently accepted), so a misconfigured downstream
adopter that keeps the shallow default degrades safely (falsely stales real bundles,
loudly, with a diagnosable line) rather than unsafely (accepting a bundle it cannot
actually verify).

## Addendum (2026-07-03, part 4): event-scoped enforcement — gates gate PRs, not `main`

Final review found a second, more severe HIGH launch-blocker in the staleness check
(Addendum part 3, above): even with full-history checkout and correct sha binding, a
`push` run on `main` immediately after a squash-merge would still falsely stale the
just-merged, genuinely legitimate bundle — because `git merge --squash` (this repo's
merge strategy) discards the original commit graph, the resulting squash commit on `main`
has **no** git ancestry back to the feature-branch commit its checkpoint was sealed
against, by design, not by defect. Empirically reproduced with a synthetic squash pair.
Left unfixed, every delivery would fail the required Trust Reconcile check on `main`
immediately post-merge, and Phase 2 attestation minting (which runs only after Step 2
passes) would stop entirely — a regression far worse than the bug this whole ADR closes.

**Decision (reviewer option (a) — enforcement is event-scoped):** bundle-required
enforcement (§1's `bundle-required-no-declared-marker` fail-closed branch, and the
staleness-gate consequence of it, Addendum part 2) applies only when a run is **gating a
proposed change** — detected via `TRUST_RECONCILE_EVENT` (set from `github.event_name` by
the workflow), with a conservative default: an absent/unrecognized event value is treated
as gating (enforce), so every existing local/test caller and any misconfigured CI event
keeps today's stricter behavior. Only the literal value `push` is treated as a post-merge
run. On `push`, an absent or stale auto-discovered bundle is a loud, exit-0 no-op
(`push event: ... — skipping Step 2 (gating happened on the PR run)`) rather than a
failure or a `delivery/DECLARED` requirement — there is no "change" being gated on a push
to a protected branch (direct pushes are already excluded by branch protection; a push
run's own job is Step 1 fresh-verify, which is unaffected by this scoping and always
runs, plus Step 2 reconcile IF the bundle happens to still attest that exact commit,
forming the Phase 2 attestation basis). `pull_request` gating is completely unaffected —
the exact same squash-shape fixture used to prove the push no-op also proves the
identical shape still fails closed when `TRUST_RECONCILE_EVENT=pull_request`, confirming
this scoping narrows *when* enforcement applies, not *how strictly* it applies when it
does. Residual (HIGH, documented not solved): `TRUST_RECONCILE_EVENT`'s
source value (`github.event_name`) is authoritative GitHub Actions context, but the
workflow FILE that assigns it to the env var is itself PR-editable content on a
`pull_request` run — a PR could hardcode `TRUST_RECONCILE_EVENT: push` in its own copy of
the workflow to fake the post-merge no-op path; this is closed by required code-owner
review on `.github/workflows/trust-reconcile.yml` (#225, not yet server-side enforced),
the same residual class as every other self-asserted CI input this ADR already carries.
Step 1 (fresh verify) is unaffected by event scoping either way and always runs.

## Addendum (2026-07-04, part 5): per-session delivery paths — concurrent deliveries stop contending (#379)

Owner-approved follow-up closing a structural defect the fail-closed gate's first real
deliveries surfaced repeatedly: the delivery transport used a SINGLE shared path
(`delivery/trust.bundle` + `delivery/trust.checkpoint.json`), so every sealed delivery
force-committed to the SAME two files. Any two concurrent deliveries therefore
merge-conflict by construction — three seal collisions inside 24h (#330, #358, #378) each
needed manual conflict resolution. Worse than the conflict itself: **GitHub schedules NO
`pull_request` workflows for a conflicting (DIRTY) PR** — zero checks, no error — so the
required Trust Reconcile check silently never re-runs. The symptom reads as "CI vanished,"
not "conflict." This collision class scales with delivery frequency; ADR 0021's own "work
area" vocabulary predicted it, and #335 named the `resolveDeliveryCandidates()` seam as the
fix site.

**Decision (structural): per-session delivery paths.** `publishDelivery()`
(`src/cli/workflow-sidecar.ts`) writes to `delivery/<slug>/trust.bundle` (+ checkpoint
companions), where `<slug>` is the session artifact dir's basename, instead of the shared
flat path. Concurrent deliveries write to DISTINCT files and cannot contend: two deliveries
add different `delivery/<slug>/` dirs (add/add of different paths — not a conflict), and both
deleting the same inherited flat/legacy file is a delete/delete (auto-merges — not a
conflict). The per-session dir NAME is only a collision-avoidance handle; it carries no
trust weight.

**Reconciler side: ownership-aware discovery, prefer-newest, not first-match.**
`resolveDeliveryCandidates()` now returns the flat path (FIRST, for full back-compat)
followed by every `delivery/<slug>/<filename>` (sorted). `discoverBundle()` no longer returns
the first-existing candidate; it collects every candidate that attests THIS change
(ancestor-or-equal, the SAME `bundleAttestsThisChange()` binding Addendum part 2 defined) and
selects the one attesting the **NEWEST** (descendant-most) commit. This prefer-newest rule is
load-bearing in a **merge-commit** repo (this repo's own history has merge commits, e.g.
release-please merges): an inherited FLAT bundle's `commit_sha` can be a REAL ancestor of HEAD
— it was committed on the trunk's linear history before this branch point — so it legitimately
"owns" the change too, and a naive first-fresh-wins would select that STALE inherited bundle
purely because it sorts first, reconciling the PREVIOUS delivery's claims against THIS change's
CI. Prefer-newest makes the fresh per-session bundle win on recency, not on being deleted
first — which in turn is what lets the cleanup policy leave the flat path in place (below)
without corrupting selection. (Addendum parts 2/4's squash-merge reasoning still holds for
squash repos; prefer-newest is the strict generalization that also covers merge-commit repos,
where "inherited ⇒ non-ancestor" is NOT guaranteed.) `extractBundleCommitSha()` now resolves a
bundle's sibling checkpoint from the bundle's OWN directory (`path.dirname(bundlePath)`), not a
global scan — a global scan would pair a per-session bundle with the wrong session's (or the
flat) checkpoint and read the wrong commit binding. For the flat layout this is byte-identical
to the prior behavior; for per-session it is the only correct pairing.

**Back-compat (retained, deprecation-noted).** The flat `delivery/trust.bundle` path stays
fully supported on the READ side: an already-committed flat bundle from before this change,
or an external adopter that has not migrated, still resolves and reconciles exactly as
before (regression-locked by the negatives suite's flat-owner-coexist case and the
unchanged `test_publish_delivery.sh` TEST 3/4 flat-fixture cases). Only the WRITE side moved
to per-session — writing to both flat and per-session would re-introduce the very contention
this closes, so the flat path is write-deprecated, read-supported.

**Cleanup policy: supersede-on-publish, per-session dirs only (delivery/ stays bounded).** A
publishing session prunes every inherited **per-session** seal dir except its own, then
commits only `delivery/<slug>/`. Per-session dirs are the growth vector (one per delivery) and
are UNIQUELY named, so pruning one can never conflict with a concurrent PR: two branches
deleting the same inherited dir is a delete/delete (auto-merges), and each delivery adds its
own distinct dir. Leaving an inherited per-session dir would be harmless anyway (prefer-newest
ignores it) — pruning is purely to stop unbounded accumulation. The alternative,
retain-as-history, was rejected as unbounded growth of permanently-superseded dirs with no
reader. Pruning is best-effort: a prune failure is logged, never fatal to the delivery.

**The shared flat path is deliberately NOT pruned per-delivery.** An earlier iteration of this
addendum also pruned the flat `delivery/trust.bundle` legacy seals on every publish (to
"migrate off" the shared path). That was reverted: during the migration window a concurrent PR
may still seal to the flat path (this was written while PR #370 had an open flat-path seal),
and a per-delivery deletion of that file is a **modify/delete conflict** against such a PR → a
DIRTY PR → precisely the no-CI failure mode this whole change exists to remove. Because the
flat path is a single fixed location (not a growth vector) and prefer-newest selection makes a
lingering flat bundle harmless, retaining it costs nothing. Removing the flat legacy seals is a
one-time cleanup for a **dedicated** PR once no open PR still seals to the flat path — not
something safely bundled into every delivery.

**The SILENT failure mode (documented, not "solved").** No repo-side code can make GitHub
run `pull_request` workflows on a conflicted PR — that is platform behavior. Per-session
paths remove the STRUCTURAL cause (the shared-path conflict) for agent-vs-agent delivery
contention, which is the overwhelming majority of the incidents. The residual — a PR that
goes DIRTY for some OTHER reason (a genuine same-file edit conflict with `main`) still gets
no CI silently — is addressed by making the failure mode LOUD where we can: the deliver
skill now documents the DIRTY→no-CI symptom and its diagnosis (`gh pr view --json
mergeStateStatus`), and `discoverBundle()` emits a grep-stable `#379: examined N delivery
candidate(s) … none attests this change …` concurrency hint so the next agent can tell a
per-session collision apart from a plain stale/absent bundle. #335's detectability half
(treating `mergeStateStatus=DIRTY` as a first-class steering/doctor input) remains open and
is explicitly NOT claimed closed here.

**Security: the forgery surface moved with the write path.** `scripts/hooks/config-protection.js`
(and its `context/` mirror) protected only the flat `delivery/trust.bundle` /
`delivery/trust.checkpoint.json` from direct agent Write/Edit/cp/redirect. Its three
delivery regexes now carry an optional `(?:[^/]+\/)?` segment so `delivery/<slug>/trust.*`
is equally blocked — otherwise moving the write path would have opened a hand-forgery hole
one directory down. Regression-locked by `test_gate_lockdown.sh` AC1.26b/c/d. The
`delivery/*` gitignore already covers per-session dirs (they are force-added deliberately per
delivery exactly like the flat path).

**Residuals (honest):** (1) the DIRTY→no-CI platform behavior for non-per-session conflicts
is documented, not eliminated (above). (2) The per-session dir name is derived from the
local session slug; a colliding slug across two sessions would re-share a path — acceptable
because ownership is still decided by commit ancestry (a stale same-named sibling is ignored,
not trusted), and slugs are session-unique in practice. (3) Selection correctness does NOT
depend on merge strategy: prefer-newest resolves the owning candidate for both squash-merge
(inherited seals are non-ancestors, trivially not-owning) and merge-commit (inherited seals
can be ancestors, but attest an OLDER commit than this session's, so they lose on recency)
histories — the merge-commit case was the concrete defect that forced prefer-newest and is
regression-locked by `test_trust_reconcile_negatives.sh` §8d against a real git repo. (4) The
flat legacy seals still on `main` are retained by design (see cleanup policy above) and remain
until a dedicated one-time cleanup PR; they are harmless (prefer-newest) but do accumulate as a
single fixed path, not a growth vector. This addendum changes WHERE seals live and HOW the
owning one is chosen; it does not touch Step 1 (fresh verify), the DECLARED exemption path, or
any fail-closed verdict — all of which are regression-locked unchanged.
