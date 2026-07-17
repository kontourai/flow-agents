# Veritas Governance Kit

Turns a repo's **Veritas-governed Repo Standards** into deterministic, agentless **gate
evidence**, and gives operators a documented, gated path to **issue** the human-approval
exemptions ADR 0022 §2/§3 lets `delivery/DECLARED` carry. Slice 1 shipped the thinnest useful
surface: one flow, one gate, that gates a real `veritas readiness` verdict. This slice adds a
second, agentless flow for exemption issuance.

This kit **wraps** [`@kontourai/veritas`](https://www.npmjs.com/package/@kontourai/veritas) via
CLI invocation plus a small kit-local trust.bundle adapter. It does **not** fork, vendor, or
reimplement Veritas's Repo Standards / evidence-check evaluation — Veritas evaluates; the kit
only projects Veritas's own recorded verdict into the Flow trust.bundle vocabulary.

The engine/surface line this kit builds on — which veritas capabilities stay an importable
evaluation-engine library and which product surface moves into this kit (the thick-kit
migration, [#646](https://github.com/kontourai/flow-agents/issues/646)–652) — is ratified in
veritas's [Engine / Surface Seam](https://github.com/kontourai/veritas/blob/main/docs/architecture/engine-surface-seam.md)
doc, which also freezes the CLI + artifact + claim-shape contract this kit's adapter consumes.

## What it contains

| Asset | Path | Purpose |
| --- | --- | --- |
| Flow | `flows/readiness-check.flow.json` | Single-gate agentless flow `readiness -> gate-check`. The gate requires a **verified** `software-readiness-verdict` trust.bundle claim. |
| Adapter | `adapter/readiness-to-trust-bundle.mjs` | Projects a `veritas readiness --check evidence --working-tree` evidence report into a Hachure `trust.bundle` (via `@kontourai/surface`), deriving the claim status from Veritas's own blocking-failure signal. |
| Fixtures | `fixtures/readiness/*.readiness-report.json` | Captured **real** Veritas readiness reports (a ready clean tree, and a not-ready tree with a required CLI artifact deleted) used by the eval. |
| Flow | `flows/exemption-issuance.flow.json` | Single-gate agentless flow `request -> human-approval-gate -> issue`. The gate requires a **verified** `no-agent-delivery-exemption-approval` trust.bundle claim (`subjectType: "delivery-scope"`) before the `issue` step's write is flow-sanctioned. Issues a `delivery/DECLARED` exemption entry per ADR 0022 §2/§3. |
| Skill | `skills/exemption-usage-review/SKILL.md` | Periodic audit skill (ADR 0022 §3): walks `delivery/DECLARED` + its `git log --follow` history and reports every standing exemption (scope, reason, approver, age since `declared_at`), flagging entries overdue for owner re-confirmation against a configurable staleness threshold. Process visibility, not enforcement — read-only, never mutates `delivery/DECLARED` or the reconciler. |
| Provisions | `assets/starter-standards/**` → `provisions[]` | Starter `.veritas/` Repo Standards a consumer repo needs to run `veritas readiness` — a faithful snapshot of `veritas init`'s Day-0 output (Repo Map, Repo Standards, authority settings, `GOVERNANCE.md`, `README.md`, claim store), shipped as data and copied verbatim by `flow-agents kit provision`. See "Scaffolding starter standards" below. |
| Provisions | `assets/starter-hooks/githooks/**` → `provisions[]` | The two governance git hooks (`veritas setup repo-hooks`'s static output): `.githooks/pre-push` (`npm run --if-present prepush`) and `.githooks/post-commit` (`veritas readiness`). Shipped verbatim; landed non-executable — activation (`chmod +x` + `git config core.hooksPath`) is a documented operator step a copy cannot perform. See "Provisioning the governance hooks". |
| Flow | `flows/standards-authoring.flow.json` | Single-gate agentless flow `propose -> human-approval-gate -> apply`. The gate requires a **verified** `standards-authoring-approval` trust.bundle claim (`subjectType: "repo-governance-change"`) before `veritas init --apply` writes the derived standards. Veritas derives and writes; the kit gates the human sign-off. See "How to author standards for a repo". |
| Skill | `skills/standards-authoring/SKILL.md` | Runbook for the standards-authoring flow: runs `veritas init --explore`/`--guided` to derive a recommendation (project name, adaptive Repo Map nodes, evidence-check inference, governance-block splice), surfaces it for human approval, then `veritas init --apply`. Wraps the veritas CLI; reimplements nothing. |

The gate uses provider-neutral Flow vocabulary (`kind: "trust.bundle"`, `bundle_claim`) — the
same vocabulary `kits/builder/flows/build.flow.json` uses. Veritas is simply the producer that
satisfies it. `claimType: "software-readiness-verdict"` is taken directly from Veritas's own
Surface projection (`veritas/src/surface/projected-claims.mjs`, surface `veritas.readiness`).

## How to run the gate

```bash
# 1. Produce a real Veritas readiness report for your change.
veritas readiness --check evidence --working-tree
#    -> writes .kontourai/veritas/evidence/veritas-<runId>.json

# 2. Project that report into a trust.bundle.
node kits/veritas-governance/adapter/readiness-to-trust-bundle.mjs \
  --report .kontourai/veritas/evidence/veritas-<runId>.json \
  --out readiness.bundle

# 3. Gate it (agentless, CI-callable — @kontourai/flow >= 1.3).
flow init
flow start kits/veritas-governance/flows/readiness-check.flow.json --run-id readiness
flow attach-evidence readiness --gate gate-check-gate --file readiness.bundle --bundle
flow evaluate readiness --gate gate-check-gate --exit-code
#    exit 0 when readiness is ready (claim verified); exit 1 (block) otherwise.
```

## Scaffolding starter standards

A repo needs a `.veritas/` Repo Standards set before `veritas readiness` can evaluate it. For kit
users this replaces standalone `veritas init`: the kit declares that starter set as `provisions[]`
in `kit.json`, and the engine copies it into the repo.

```bash
# Copy the starter .veritas/ standards into the current repo (create-only; never overwrites).
flow-agents kit provision veritas-governance
#   -> .veritas/repo-map.json, .veritas/repo-standards/default.repo-standards.json,
#      .veritas/authority/default.authority-settings.json, .veritas/GOVERNANCE.md,
#      .veritas/README.md, veritas.claims.json
# (flow-agents init --activate-kit veritas-governance provisions the same set at adoption time.)

# Then run readiness against the scaffolded repo.
veritas readiness --working-tree     # 0 failures on the fresh starter
```

The provisioned files are a **faithful snapshot of `veritas init`'s Day-0 output** — data the kit
copies verbatim, not evaluation logic it reimplements. The project name is a `your-project`
placeholder; edit the Repo Map's work-area graph and `evidence.evidenceChecks[0].command` for your
repo, then regenerate the claim store with `veritas claim init`.

**Beyond the static starter:** the per-repo *derivation* `veritas init` performs (project-name
slug, repo-shape-adaptive Repo Map nodes, evidence-check inference) and the *splice* of the
governance block into an existing `AGENTS.md`/`CLAUDE.md` (a create-only copy cannot edit files in
place — the starter's `ai-instruction-files-synced` standard reports advisory until those blocks
are wired) are handled by the **standards-authoring flow** below; repo-hook setup remains #648.

## How to author standards for a repo

Beyond the static starter set, the kit's `standards-authoring` flow drives Veritas's *adaptive*
authoring — deriving the project name, repo-shape Repo Map nodes, and evidence-check command from
the actual repo, and splicing the governance block into existing `AGENTS.md`/`CLAUDE.md` (the
per-repo work a verbatim provision copy cannot do). The `standards-authoring` **skill**
(`skills/standards-authoring/SKILL.md`) is the operator's runbook; **Veritas does the derivation
and the write — the kit only gates the human sign-off.**

```bash
# 1. PROPOSE — derive a recommendation (writes nothing under .veritas/ yet).
veritas init --explore          # or: veritas init --guided --answers <answers.json>

# 2. APPROVE — a human reviews the recommendation, then authors a Hachure trust.bundle asserting
#    a standards-authoring-approval / repo-governance-change claim with status verified.
flow init
flow start kits/veritas-governance/flows/standards-authoring.flow.json --run-id authoring
flow attach-evidence authoring --gate human-approval-gate --file approval.bundle --bundle
flow evaluate authoring --gate human-approval-gate --exit-code
#    exit 0 once the approval claim is verified; exit 1 (block) otherwise.

# 3. APPLY — only after the gate passes, write the approved standards (hash-verified;
#    refuses to overwrite existing standards without --force).
veritas init --apply --plan <path-to-recommendation-artifact>
```

Like `exemption-issuance`'s gate, "human-approved" here is an **operating convention** the claim
encodes, not a structural human-only guarantee — see "Human-approval evidence: what is and is not
enforced" below. This flow is **agentless** (the kit declares no `flow_step_actions`; the approval
bundle is human-authored out of band, and the skill is the runbook, not a step-bound action). The
kit **wraps** the `veritas` CLI and reimplements no derivation or evaluation.

## Provisioning the governance hooks

The kit ships the two governance git hooks (`veritas setup repo-hooks`'s static output) as
`provisions[]`, so kit adoption drops them into the repo alongside the starter standards:

- `.githooks/pre-push` — runs `npm run --if-present prepush` before a push.
- `.githooks/post-commit` — runs `veritas readiness --changed-from HEAD~1 --changed-to HEAD` after each commit.

```bash
# 1. Land the hook files (part of `kit provision` / `init --activate-kit`).
flow-agents kit provision veritas-governance

# 2. ACTIVATE — the two steps a create-only file copy cannot perform:
chmod +x .githooks/pre-push .githooks/post-commit
git config core.hooksPath .githooks
```

**Activation is required and is not a copy.** A provision lands the hook files **non-executable**
and does not touch git config — so until you `chmod +x` them and point `core.hooksPath` at
`.githooks`, git will not run them. This is the same class of limitation as the governance-block
splice above: the engine's file copy is deliberately agent-blind (it never sets an executable bit
or mutates git config), so making the hooks *active* is an explicit operator step. The hooks
themselves only **invoke** the `veritas` CLI (`npm run prepush`, `veritas readiness`); the kit
reimplements no evaluation, and the live per-edit PreToolUse *evaluation* entry point stays in the
engine (`evaluatePreToolUse` → `evaluateRepoStandards`), reached by the installed hook shelling
into `veritas` — hook wiring is the kit's; per-edit evaluation is the engine's.

## How to issue a no-agent-delivery exemption

`flows/exemption-issuance.flow.json` (ADR 0022 §3, "the kit issues, the anchor enforces") gives
an operator who needs to declare a `no-agent-delivery` exemption — e.g. dependabot,
release-please, or another non-agent actor class — a documented, gated path instead of
hand-writing `delivery/DECLARED` JSON blind. See `delivery/README.md` for how `delivery/`
itself is used by CI, and ADR 0022 §3 for why issuance/audit live in this kit while enforcement
stays anchor-side (`scripts/ci/trust-reconcile.js`, unmodified and unaware of this kit).

```bash
# 1. A human approver authors a Hachure trust.bundle asserting the exemption approval.
#    (No adapter script exists for this slice -- the bundle is hand-authored or produced
#    by whatever approval tooling records the decision; see "Human-approval evidence: what
#    is and is not enforced" below for why this is convention, not a structural human-only
#    guarantee.)
#    Minimal bundle shape: {schemaVersion, source, claims:[{claimType:
#    "no-agent-delivery-exemption-approval", subjectType: "delivery-scope",
#    status: "verified", ...}], evidence:[...], policies:[...], events:[...]}

# 2. Gate it (agentless, CI-callable).
flow init
flow start kits/veritas-governance/flows/exemption-issuance.flow.json --run-id exemption
flow attach-evidence exemption --gate human-approval-gate --file approval.bundle --bundle
flow evaluate exemption --gate human-approval-gate --exit-code
#    exit 0 once the approval claim is verified; exit 1 (block) otherwise.

# 3. Once the gate passes, append the approved entry to delivery/DECLARED (append, do NOT
#    overwrite an existing array -- see delivery/DECLARED's current 2-entry file on main).
#    All four fields are required: scope, reason, approved_by, declared_at. Compound scope
#    forms (space-separated, ANDed -- e.g. "author:github-actions[bot]
#    branch-prefix:release-please--") are supported by the reconciler's scope matcher; see
#    ADR 0022's compound-scope addendum.
```

Example appended entry (third element of the existing `delivery/DECLARED` array — never a
replacement of it):

```json
{
  "scope": "author:some-bot[bot]",
  "reason": "why this actor class needs the exemption",
  "approved_by": "<human approver identity/decision reference>",
  "declared_at": "<ISO 8601 timestamp>"
}
```

## How to run the review

`skills/exemption-usage-review/SKILL.md` (ADR 0022 §3, "the kit issues, the anchor
enforces... and the kit audits") gives an operator a periodic, read-only way to see every
`delivery/DECLARED` exemption currently standing, how old each one is, and which are overdue
for owner re-confirmation. This is **process visibility, not enforcement** — it never
modifies `delivery/DECLARED` and never changes `scripts/ci/trust-reconcile.js`'s
reconciliation decision or exit code.

```bash
# Human-readable report against this repo's real delivery/DECLARED, default 90-day threshold.
node kits/veritas-governance/skills/exemption-usage-review/review-exemptions.mjs

# Machine-readable, with a deterministic "now" and a tighter threshold.
node kits/veritas-governance/skills/exemption-usage-review/review-exemptions.mjs \
  --as-of 2026-07-05T00:00:00Z --stale-days 30 --json
```

Each standing exemption is reported as `{scope, reason, approved_by, declared_at, age_days,
stale}`; a `git log --follow -- delivery/DECLARED` history walk is reported alongside it as a
supplementary commit-level trail. See the skill's own SKILL.md for the full "what this review
does and does not verify" statement (it does not authenticate `approved_by`, does not
re-evaluate whether any scope currently matches a given change — that remains
`trust-reconcile.js`'s job — and does not schedule itself; an operator runs it periodically).

## Human-approval evidence: what is and is not enforced

The `human-approval-gate`'s `expects[]` entry only requires a **verified** trust.bundle claim
of the right `claimType` (`no-agent-delivery-exemption-approval`) and `subjectType`
(`delivery-scope`). **Flow's schema and CLI do not distinguish a human-authored bundle from an
agent-authored one** — `trust-bundle.schema.json`'s `source` and `producerId` fields are
free-text, with no enum, no cryptographic binding, and no CLI-side identity check.
"Human-attached" is an **operating convention** this flow's `description`/`explore_hint` text
encode (the gate's own copy tells an operator this evidence is meant to be authored by a human
approver out-of-band), not a mechanism the gate itself enforces. Anyone who can run `flow
attach-evidence --bundle` with a conforming bundle can satisfy this gate, exactly as anyone with
commit access could already hand-author `delivery/DECLARED` directly.

This is the same class of residual ADR 0022 already carries honestly for the marker file
itself: `approved_by` on `delivery/DECLARED` is free text, not bound to an authenticated
identity, mitigated by the loud, un-suppressible DECLARED line plus CODEOWNERS review on
`/delivery/DECLARED` — not by identity attestation. This flow adds **guidance and an audit
trail** (a named gate, a named claim type, a documented sequence) on top of that same
mitigation, not a new authentication boundary. Structural producer authentication — binding
gate satisfaction to an authenticated producer identity, rather than to a schema-valid claim
attached by anyone with CLI access — is upstream **Flow trusted-producer** work
(`docs/operating-layers.md`, `docs/flow-kit-repository-contract.md` in this repo describe the
config surface; the config itself is Flow-core, tracked at #225/#293-family), not something
this kit's `.flow.json` can itself express. Do not read a passing `human-approval-gate` as a
structural guarantee that a human attached the evidence — read it as "a verified claim of the
right shape was attached," full stop.

## Semantics

**Settled** (owner-ratified + investigation-confirmed; see
`.kontourai/flow-agents/ws5-governance-kit-slice1` session findings). The adapter derives the
readiness gate verdict from **blocking failures** in Veritas's own recorded results: a
`Require`-enforcement policy failure, an uncovered-path `fail`, a failed selected evidence check,
or a blocking external-tool `fail`/`missing` makes the verdict **not-ready** → the
`software-readiness-verdict` claim derives a non-`verified` status → the gate **blocks**. A ready
verdict derives `verified` → the gate **passes**.

This matches Veritas's own `readinessHasBlockingFailure` helper (`veritas/src/surface/readiness.mjs`)
and Surface's weakest-link claim derivation (`buildTrustReport` downgrades a readiness claim to
`rejected` on any rejected Require). The adapter does **not** apply Veritas's `promotion_allowed`
short-circuit as a safety signal — `promotion_allowed` is a workstream-routing hint (set by
file-pattern lane resolution in `src/repo/routing.mjs`) and cannot account for blocking failures.
The historical divergence this guarded against,
[kontourai/veritas#106](https://github.com/kontourai/veritas/issues/106) (Veritas's exported
verdict functions honored `promotion_allowed` before checking blocking failures), is **fixed**:
`readinessVerdict`/`readinessSurfaceStatus` now check `readinessHasBlockingFailure()` first
(regression-tested in veritas `tests/surface/readiness-verdict.test.mjs`), so the adapter's
derivation and Veritas's exported functions agree. The adapter keeps its own derivation because
kit code consumes Veritas's recorded artifact, not Veritas's library exports — that
blocking-failure semantics is now frozen in veritas's Engine / Surface Seam doc (see above).

## Trust status

Slice 1 ships **unverified** (like all current kits). Official catalog placement is marketplace
metadata only and grants no runtime privilege. Verified promotion is an owner decision deferred
to a later slice (see the WS5 shaping's open decisions).

## Not in slice 1

Skills `consult-standards` and `governance-evidence`, the fuller `merge-readiness` flow, and the
`knowledge` dependency are later slices — see the WS5 backlog. The **starter-standards scaffold**
(`veritas init`'s Day-0 `.veritas/` set) **has now shipped** as `provisions[]` (see "Scaffolding
starter standards"), and the **`standards-authoring` flow** that covers the per-repo derivation
and governance-block splice a static copy cannot **has now shipped** too (see "How to author
standards for a repo") — both #647 Slice 2; repo-hook setup remains #648.
`exemption-usage-review` (ADR 0022 §3's periodic audit skill, walking
`delivery/DECLARED` history and surfacing standing exemptions for owner re-confirmation —
process visibility, not enforcement) **has now shipped** — see "What it contains" above and
"How to run the review". Nothing schedules it automatically; an operator runs it periodically
(see the skill's own "Accepted gap" note) — that scheduling surface remains out of scope.
