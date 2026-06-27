# delivery/

**CI trust anchor transport path — committed delivery checkpoint/bundle.**

This directory is the committed transport path for trust artifacts at delivery time.
The `.github/workflows/trust-reconcile.yml` CI job reads from here to reconcile
agent-claimed passes against fresh CI reality.

## Files

| File | Status | Description |
| ---- | ------ | ----------- |
| `trust.bundle` | Phase-1b | Published session trust bundle with evidence/claims. Enables per-command reconciliation. Written automatically by `record-release` / `advance-state --status delivered` via `publishDelivery()`, or explicitly via `npm run workflow:sidecar -- publish-delivery <artifact-dir>`. |
| `trust.checkpoint.json` | Phase-1b | Lightweight checkpoint envelope (statusByClaimId). Written at the same time as `trust.bundle`. |
| `trust.checkpoint.intoto.json` | Phase-1b | Unsigned in-toto statement (local/CI without ambient OIDC). Present when signing ran locally. |
| `trust.checkpoint.sig.json` | Phase-1b | Cosign-verifiable DSSE envelope (CI/OIDC path). Present when Sigstore keyless signing succeeded. |

## How it works

1. **Agent delivers** — at delivery time, `record-release` (or `advance-state --status delivered`)
   automatically calls `publishDelivery()` in `src/cli/workflow-sidecar.ts`, which copies
   `trust.bundle` and companion files here. The deliver skill stages these files and includes
   them in the delivery commit/PR. The agent can also publish explicitly:
   ```
   npm run workflow:sidecar -- publish-delivery .flow-agents/<slug>
   git add delivery/trust.bundle delivery/trust.checkpoint.json
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
  (`.flow-agents/<slug>/`) to this `delivery/` directory.
- Fail-soft: does nothing if `trust.bundle` is absent (no crash, no error).
- Idempotent: overwrites on re-delivery.
- Called best-effort from `recordRelease` and `advanceState` → `delivered`.
- Also exposed as `publish-delivery <artifact-dir>` subcommand for explicit use.

See `scripts/ci/trust-reconcile.js`, `evals/integration/test_trust_reconcile.sh`,
and `evals/integration/test_publish_delivery.sh`.
