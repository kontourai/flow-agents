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
