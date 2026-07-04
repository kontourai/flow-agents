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
