---
title: "Trust Anchor Adoption — Add the CI Trust Anchor to Your Repo"
---

# Trust Anchor Adoption

This guide explains how to add the Flow Agents CI trust anchor to any repository that
uses Flow Agents. The anchor is a required CI job that re-runs your canonical
verification fresh in a clean environment and reconciles the agent's claimed passes
against the real CI results. It is the external, un-disablable check that closes the
loop on agent self-reporting.

See [ADR 0017](adr/0017-anti-gaming-trust-security-model.md) for the full security
model and threat analysis.

## What the Trust Anchor Does

1. **Re-runs verification fresh.** In a clean CI environment the agent does not
   control, it runs your declared verify command (build + tests + lint). Real exit
   codes. No agent influence.

2. **Reconciles the delivered bundle.** If the agent published a `delivery/trust.bundle`
   with the PR, the anchor cross-checks every claimed-pass command against CI's own
   fresh results. Divergences (claimed pass + CI fail, laundered command, claim with
   no evidence, checkpoint-only bundle) fail the job with a clear diagnostic.

3. **Fails closed on compile-only.** If no comprehensive verify command is configured,
   the anchor refuses to pass — preventing a "build only" attestation that misses tests.

## Step 1 — The Agent Publishes a Bundle

Flow Agents' deliver skill calls `publishDelivery`, which writes `delivery/trust.bundle`
to the repository with `git add -f` during the `record-release` step. This file carries
the session's evidence and claims to CI so the anchor can reconcile them.

You do not need to configure this — it is part of the deliver skill workflow. The bundle
is gitignored by default (the deliver skill force-adds it for the PR commit only).

## Step 2 — Add the Composite Action

In your repo, create or update a CI workflow file (e.g.
`.github/workflows/trust-verify.yml`):

```yaml
name: Trust Verify

on:
  pull_request:
  push:
    branches: ["main"]
  workflow_dispatch:

permissions:
  contents: read

concurrency:
  group: trust-verify-${{ github.ref }}
  cancel-in-progress: true

jobs:
  trust-verify:
    name: Trust Verify
    runs-on: ubuntu-latest
    timeout-minutes: 15
    # Add id-token: write here if you enable sign: true (Sigstore attestation).
    permissions:
      contents: read

    steps:
      - name: Checkout
        uses: actions/checkout@df4cb1c069e1874edd31b4311f1884172cec0e10 # v6.0.3

      - uses: kontourai/flow-agents/.github/actions/trust-verify@<SHA>
        with:
          # Declare your comprehensive verify command: build + tests + lint.
          # The agent must run this same command locally (via trust-reconcile-verify).
          verify-command: "npm run build && npm test && npm run lint"
          # bundle: defaults to delivery/trust.bundle (auto-discovered if present)
          # sign: false (set to true + add id-token: write for Sigstore attestation)
```

Replace `<SHA>` with the pinned commit SHA of the `kontourai/flow-agents` release you
are adopting. Pin to a SHA (not a tag) for supply-chain security.

**To find the SHA**: look at the
[flow-agents releases](https://github.com/kontourai/flow-agents/releases) or pin to
`main` HEAD after reviewing the CHANGELOG.

## Step 3 — Arm It as a Required Status Check

The action reports results but is advisory until you arm it server-side:

1. Go to **Settings → Branches** in your GitHub repository.
2. Edit (or create) the branch protection rule for `main`.
3. Under **Require status checks to pass before merging**, add **`Trust Verify`**.
4. Check **Require branches to be up to date before merging**.
5. Enable **Do not allow bypassing the above settings** (the "enforce admins" option).

Once armed, no PR can merge past a `Trust Verify` failure — including ones pushed by
the agent.

## Step 4 — Protect the Verify Config

CODEOWNERS prevents the agent from quietly weakening the verify command. Add entries
for the files that declare what CI runs:

```
# Trust anchor config — requires owner review.
# An agent cannot weaken verify-command without a human approving the change.
.github/workflows/trust-verify.yml  @your-org/owners
package.json                         @your-org/owners
```

Adjust paths and team names for your repo structure.

## Configuring the Verify Command

The anchor fails closed if it cannot find a comprehensive verify command. Provide it
one of three ways (in priority order):

1. **Action input** `verify-command` (recommended for the composite action).
2. **`TRUST_RECONCILE_COMMANDS` environment variable** (comma- or newline-separated).
3. **`package.json` `scripts["trust-reconcile-verify"]`** — the anchor auto-discovers
   this key. Add it to your `package.json`:

   ```json
   {
     "scripts": {
       "trust-reconcile-verify": "npm run build && npm test && npm run lint"
     }
   }
   ```

   Then you can also run it locally:
   ```
   npx @kontourai/flow-agents verify
   ```

## Local Use

The `flow-agents verify` CLI subcommand runs the same trust-reconcile logic locally:

```bash
# Install (or npx):
npm install -D @kontourai/flow-agents

# Re-run verify + reconcile against a delivered bundle:
npx @kontourai/flow-agents verify \
  --commands "npm run build,npm test" \
  --bundle delivery/trust.bundle

# Auto-discover bundle + verify command from package.json:
npx @kontourai/flow-agents verify

# Help:
npx @kontourai/flow-agents verify --help
```

Exit codes: 0 = clean (fresh verify passed, no divergence); 1 = failed/divergence.

## Mirror: Flow Agents' Own Setup

Flow Agents uses the same pattern in its own repository:

- **`scripts/ci/trust-reconcile.js`** — the anchor script (runs in
  `.github/workflows/trust-reconcile.yml`).
- **`package.json` `trust-reconcile-verify`** — `npm run build && npm run eval:static`.
- **`evals/ci/antigaming-suite.sh`** — the regression suite that proves the gate and
  anchor work; runs in the required `ci.yml` lane.
- **Branch protection** on `main` — `Trust Reconcile` required, `enforce_admins` on.

## Adoption Checklist

- [ ] Deliver skill is configured and publishes `delivery/trust.bundle`.
- [ ] `.github/workflows/trust-verify.yml` added and the composite action is pinned.
- [ ] `verify-command` declares a comprehensive verify (build + tests + lint).
- [ ] `Trust Verify` added as a required, no-bypass status check on `main`.
- [ ] CODEOWNERS entry protects `trust-verify.yml` and `package.json`.
- [ ] (Optional) `scripts["trust-reconcile-verify"]` in `package.json` for local use.
- [ ] (Optional) `sign: true` + `id-token: write` for Sigstore attestation.

## Troubleshooting

**"no comprehensive trust-reconcile-verify configured"**: Provide `verify-command` in
the action input, set `TRUST_RECONCILE_COMMANDS`, or add `scripts["trust-reconcile-verify"]`
to `package.json`. The anchor refuses to attest a compile-only check.

**"trust divergence: agent claimed X passed; CI fresh run = FAIL"**: The agent's
local environment or shell profile produced a false pass. The anchor correctly flagged
the mismatch. Fix the underlying test failure.

**"trust divergence: command contains exit-code-laundering operator"**: A claimed
command used `||`, `; true`, or `; exit 0`. These mask real exit codes. Remove them.

**"checkpoint-only bundle cannot be reconciled per-command"**: A `delivery/trust.bundle`
was expected but only `delivery/trust.checkpoint.json` was found. The deliver skill
publishes the full bundle; ensure it ran correctly.
