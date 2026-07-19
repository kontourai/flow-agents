# delivery/

**CI trust anchor transport path — committed delivery checkpoint/bundle.**

This directory is the committed transport path for trust artifacts at delivery time.
The `.github/workflows/trust-reconcile.yml` CI job reads from here to reconcile
agent-claimed passes against fresh CI reality.

## Layout — per-session paths (#379)

Deliveries write to a **per-session** subdirectory `delivery/<slug>/` (where `<slug>` is the
session artifact dir's basename), NOT a shared flat file:

```
delivery/
  <slug-a>/trust.bundle
  <slug-a>/trust.checkpoint.json
  <slug-b>/trust.bundle          # a concurrent delivery — distinct path, no conflict
  README.md                      # tracked
  DECLARED                       # tracked governance marker (ADR 0022 §2)
```

**Why:** a single shared `delivery/trust.bundle` guaranteed a git merge conflict between ANY
two concurrent deliveries, and a conflicting (DIRTY) PR gets **no `pull_request` workflows**
from GitHub — the required Trust Reconcile check silently never runs (field incidents
#330/#358/#378; root cause #335). Per-session paths let concurrent deliveries write DISTINCT
files that never contend.

**Flat path — DEPRECATED (read-supported, write-removed):** the legacy flat
`delivery/trust.bundle` (+ `trust.checkpoint*.json`) is **no longer written or committed in
THIS repo** — its stale seals were removed in the #385-sanctioned one-time cleanup (see
below). The reconciler's flat-path READ support is **deliberately retained**, because it is
part of the cross-repo `.github/actions/trust-verify` contract: that composite action defaults
`bundle: delivery/trust.bundle` and `docs/trust-anchor-adoption.md` instructs downstream
adopters to publish the flat path, so an external consumer (e.g. `kontourai.io`, which pins and
runs the shared action) may still seal flat. Removing READ support would break that public
contract. Within this repo, prefer the per-session `delivery/<slug>/` layout; the flat path is
for backward compatibility only and should not be re-introduced here.

**Back-compat + prefer-newest selection:** the legacy flat `delivery/trust.bundle` is still
READ and reconciled (an already-committed flat bundle, or a downstream adopter that has not
migrated, works unchanged). Only the WRITE path moved to per-session — writing both would
re-introduce the contention. `scripts/ci/trust-reconcile.js` `resolveDeliveryCandidates()`
returns the flat path first (precedence) then every `delivery/<slug>/…`, and `discoverBundle()`
selects, among all candidates that attest THIS change (`bundleAttestsThisChange()`), the one
attesting the **NEWEST** commit. This matters in a merge-commit repo: an inherited flat
bundle's `commit_sha` can be a REAL ancestor of HEAD (committed on the trunk before this
branch), so it "owns" the change too — but this session's per-session bundle attests a newer
ancestor and wins on recency, not on being deleted first. Stale (non-owning) siblings are
ignored entirely.

**Cleanup (supersede-on-publish):** `publishDelivery()` prunes every inherited per-session
seal dir except its own before writing, so `delivery/` stays bounded. Per-session dirs are
uniquely named, so pruning one can never conflict with a concurrent PR (delete/delete
auto-merges; each PR adds its own distinct dir). The shared flat `delivery/trust.bundle`
legacy path is deliberately NOT pruned per-delivery: during the migration window a concurrent
PR may still seal to it, and deleting it would be a modify/delete conflict → a DIRTY PR → the
no-CI failure this whole change fixes. The flat path is a single fixed location (not a growth
vector) and prefer-newest makes a lingering flat bundle harmless; removing the flat legacy
seals is a one-time cleanup for a dedicated PR once no open PR still seals there. **That
cleanup is done (#385-sanctioned):** this repo's stale flat `trust.bundle` + `trust.checkpoint*.json`
have been removed from git tracking. The reconciler's flat READ support stays for external
adopters (see the DEPRECATED note above); only THIS repo's stale flat files were deleted.

## Files (per `delivery/<slug>/`)

| File | Status | Description |
| ---- | ------ | ----------- |
| `trust.bundle` | Phase-1b | Published session trust bundle with evidence/claims. Enables per-command reconciliation. Written automatically by `record-release` / `advance-state --status delivered` via `publishDelivery()`, or explicitly via `npm run workflow:sidecar -- publish-delivery <artifact-dir>`. |
| `trust.checkpoint.json` | Phase-1b | Lightweight checkpoint envelope (statusByClaimId) carrying the `commit_sha` binding the reconciler uses for ownership. Written at the same time as `trust.bundle`. |
| `trust.checkpoint.intoto.json` | Phase-1b | Unsigned in-toto statement (local/CI without ambient OIDC). Present when signing ran locally. |
| `trust.checkpoint.sig.json` | Phase-1b | Cosign-verifiable DSSE envelope (CI/OIDC path). Present when Sigstore keyless signing succeeded. |

## `DECLARED` scope forms

`delivery/DECLARED` (flat, not per-session — see "Layout" above) is the committed
no-agent-delivery exemption marker `scripts/ci/trust-reconcile.js` auto-discovers when no
`trust.bundle` is present (ADR 0022 §1/§2). It exempts Step 2 (bundle reconciliation) ONLY —
Step 1 (fresh verify) is never exempted by anything documented here. This section documents
the marker's required fields and `scope` grammar so a future exemption author does not have
to reverse-engineer it from `trust-reconcile.js` source. The semantics below are sourced
directly from `matchesScopeCondition()`/`matchesScope()` in `scripts/ci/trust-reconcile.js`
(line numbers shift as the file changes; match by function name, not a pinned line range)
— cross-check that file if this doc and the code ever appear to disagree; the code is
authoritative.

**Required fields.** Every `delivery/DECLARED` entry is a JSON object with all four of:

| Field | Meaning |
| ---- | ----------- |
| `scope` | One or more space-separated conditions (see forms below) the reconciler matches against the resolved ref/actor/sha context. All conditions in a `scope` string must match (AND) for the entry to apply. |
| `reason` | Free-text justification for the exemption (e.g. "dependabot dependency-update PRs; no agent delivery involved"). |
| `approved_by` | Free-text approver identity/decision reference. Not cryptographically bound — see ADR 0022 §2's residual note; mitigated by CODEOWNERS review on this file (below), not by identity attestation. |
| `declared_at` | ISO 8601 timestamp of when the exemption was approved. |

A marker missing any of these four fields on an entry is treated as malformed and falls
through to the fail-closed default (`bundle-required-no-declared-marker`), same as if no
marker existed at all.

**Scope forms.** A `scope` string is one or more space-separated conditions; each condition
is one of exactly four forms (string equality/prefix matching only — **no `RegExp` is ever
constructed from marker content**, in either the single- or compound-condition path):

| Form | Matches against | Example |
| ---- | ---------------- | ------- |
| `ref:<exact>` | The resolved ref (`TRUST_RECONCILE_REF` \|\| `GITHUB_HEAD_REF` \|\| `GITHUB_REF` stripped of `refs/heads/`), exact string equality | `ref:release-please--branches--main` |
| `commit:<sha>` or `commit:<from>..<to>` | The resolved sha, either exact equality or ancestor-range membership (`git merge-base --is-ancestor`) | `commit:5f2a1c9` or `commit:5f2a1c9..8b40e21` |
| `author:<exact>` | The resolved actor (`TRUST_RECONCILE_ACTOR` \|\| `GITHUB_ACTOR`), exact string equality | `author:dependabot[bot]` |
| `branch-prefix:<prefix>` | The resolved ref, via `String#startsWith` | `branch-prefix:release-please--` |

Every arm also requires the *compared context value itself* to be non-empty — an empty
ref/actor/sha (e.g. invoking the reconciler locally with no override set) can never be
treated as a wildcard match. An unrecognized condition prefix anywhere in a scope — single or
compound — makes the **whole** scope never match (fail closed), not merely that one
condition.

**Compound scope (space-separated AND).** Multiple conditions in one `scope` string are
ANDed — every condition must match for the entry to apply; a single-condition scope is just
the N=1 case of the same rule (unchanged, backward compatible). The production worked example
is this repo's own `delivery/DECLARED` release-please entry:

```json
{
  "scope": "author:github-actions[bot] branch-prefix:release-please--",
  "reason": "release-please automation PR; no agent delivery involved",
  "approved_by": "brian.anderson1222 (AC8 option-a decision, ADR 0022 approval 2026-07-02)",
  "declared_at": "2026-07-03T16:27:21Z"
}
```

**`ref:`/`branch-prefix:` alone are insufficient for identity exemptions.** Per the ADR 0022
2026-07-03 addendum: `ref:`/`branch-prefix:` match against `GITHUB_HEAD_REF`, which is
**pusher-controlled on a fork PR** — anyone who can open a PR can name their branch to satisfy
a `ref:`- or `branch-prefix:`-only scope. A scope meant to identify a specific bot/automation
actor (as opposed to a specific commit range or branch, where the identity question does not
arise) MUST combine `branch-prefix:` (or `ref:`) with `author:`, as the release-please example
above does, so the platform-set actor identity — not just a self-chosen branch name — also has
to match. `author:` alone does not have this weakness (`GITHUB_ACTOR` is platform-set, not
pusher-chosen), which is why this repo's `dependabot[bot]` entry (`author:dependabot[bot]`)
was security-review-confirmed sufficient on its own with no `branch-prefix:` needed — identity
alone, not branch/ref, is the relevant boundary for that actor.

**Array form + append, never clobber.** `delivery/DECLARED` accepts either a single
`{scope, reason, approved_by, declared_at}` object or a JSON array of such objects, so one
marker file can cover multiple non-agent-delivery scopes (e.g. dependabot AND release-please)
without a blanket scope. Every entry is validated independently — one malformed entry does
not mask a well-formed one elsewhere in the array, and the reconciler returns the first
in-scope, well-formed entry that matches. When adding a new exemption, **append** a new
element to the existing array; do not overwrite or replace the entries already present.

**CODEOWNERS.** `/delivery/DECLARED` is listed in `.github/CODEOWNERS` alongside the other
verify-config/anchor paths (`/scripts/ci/`, `/package.json`, `/evals/run.sh`) — the same
mitigation applied to every other self-asserted, unauthenticated field in this trust chain
(ADR 0022 §2). This file (`delivery/README.md`) itself is not a protected path; only the
`DECLARED` marker file is.

**Where to go next.** The exemption grammar and anchor enforcement remain defined here and
in ADR 0022. Optional governance authoring or review guidance belongs in an external
governance kit; Flow Agents does not bundle a product-specific issuer or reviewer.

## How it works

1. **Agent delivers** — at delivery time, `record-release` (or `advance-state --status delivered`)
   automatically calls `publishDelivery()` in `src/cli/workflow-sidecar.ts`, which copies
   `trust.bundle` and companion files into `delivery/<slug>/`. The deliver skill force-stages
   these files (they are gitignored) and includes them in the delivery commit/PR. The agent
   can also publish explicitly:
   ```
   npm run workflow:sidecar -- publish-delivery .kontourai/flow-agents/<slug>
   git add -f delivery/<slug>/
   ```

2. **CI re-runs** — `trust-reconcile.yml` runs `scripts/ci/trust-reconcile.js` in a
   clean environment the agent does not control. It re-runs canonical verification
   (default: `npm run build`) fresh, recording real exit codes.

3. **CI reconciles** — for every evidence item in `trust.bundle` where `passing: true`
   (claimed pass), CI looks up its fresh result. Claimed pass + CI fail = DIVERGENCE
   → the job exits 1 with a clear diagnostic naming the command.

## Trust model

CI **never** trusts the bundle as a source of truth. The bundle is used only to
DETECT DIVERGENCE between what the agent claimed and what CI actually sees.

An agent that forges `passing: true` in the bundle will be caught when CI re-runs
the same command and finds a different result.

## Implementation

`publishDelivery(dir, repoRoot)` in `src/cli/workflow-sidecar.ts`:
- Copies `trust.bundle` and checkpoint companions from the session artifact dir
  (`.kontourai/flow-agents/<slug>/`) to this directory's **per-session** subpath
  `delivery/<slug>/` (#379), not the shared flat path.
- Prunes inherited per-session seal dirs (except its own) before writing, so `delivery/`
  stays bounded (supersede-on-publish; best-effort). Does NOT prune the shared flat legacy
  seal (a concurrent PR may still seal there; prefer-newest selection makes it harmless).
- Fail-soft: does nothing if `trust.bundle` is absent (no crash, no error).
- Idempotent: overwrites on re-delivery to the same slug.
- Called best-effort from `recordRelease` and `advanceState` → `delivered`.
- Also exposed as `publish-delivery <artifact-dir>` subcommand for explicit use.

See `scripts/ci/trust-reconcile.js`, `evals/integration/test_trust_reconcile.sh`,
and `evals/integration/test_publish_delivery.sh`.
