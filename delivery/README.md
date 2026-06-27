# delivery/

**CI trust anchor transport path — committed delivery checkpoint/bundle.**

This directory is the committed transport path for trust artifacts at delivery time.
The `.github/workflows/trust-reconcile.yml` CI job reads from here to reconcile
agent-claimed passes against fresh CI reality.

## Files

| File | Status | Description |
| ---- | ------ | ----------- |
| `trust.bundle` | Phase-1b | Full trust bundle with evidence/claims. Enables per-command reconciliation. Written by the deliver skill at delivery time (Phase-1b follow-up). |
| `trust.checkpoint.json` | Phase-1b | Lightweight checkpoint envelope (statusByClaimId). Written at the same time as trust.bundle. |

## How it works

1. **Agent delivers** — at delivery time the deliver skill writes `trust.bundle` here,
   committing the agent's claimed pass/fail state for each verification command.

2. **CI re-runs** — `trust-reconcile.yml` runs `scripts/ci/trust-reconcile.js` in a
   clean environment the agent does not control. It re-runs canonical verification
   (default: `npm run build`) fresh, recording real exit codes.

3. **CI reconciles** — for every evidence item in the bundle where `passing: true`
   (claimed pass), CI looks up its fresh result. Claimed pass + CI fail = DIVERGENCE
   → the job exits 1 with a clear diagnostic naming the command.

## Trust model

CI **never** trusts the bundle as a source of truth. The bundle is used only to
DETECT DIVERGENCE between what the agent claimed and what CI actually sees.

An agent that forges `passing: true` in the bundle will be caught when CI re-runs
the same command and finds a different result.

## Phase-1b follow-up

The `deliver` skill does not yet write to this directory automatically. As a Phase-1b
follow-up, wire the skill to copy `trust.bundle` and `trust.checkpoint.json` here
at delivery time. For now, write manually or leave the directory empty — CI falls
back to fresh-verify-only mode when no bundle is present.

See `scripts/ci/trust-reconcile.js` and `evals/integration/test_trust_reconcile.sh`.
