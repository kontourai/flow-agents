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

2. **Reconciles the delivered bundle.** If the agent published a canonical
   `delivery/<task-slug>/trust.bundle` (or legacy `delivery/trust.bundle`) with the PR,
   the anchor cross-checks every claimed-pass command against CI's own
   fresh results. Divergences (claimed pass + CI fail, laundered command, claim with
   no evidence, checkpoint-only bundle) fail the job with a clear diagnostic.

3. **Fails closed on compile-only.** If no comprehensive verify command is configured,
   the anchor refuses to pass — preventing a "build only" attestation that misses tests.

4. **Makes bundle absence explicit.** `missing-bundle-policy: required` is the stable,
   fail-closed default for an armed gate. During advisory adoption, set
   `missing-bundle-policy: advisory`: fresh verification must still pass, while a missing
   current bundle is reported without failing the job. Bundle divergence and failed fresh
   verification always fail; the legacy `fail-on-divergence` input no longer weakens the gate.

## Step 1 — The Agent Publishes a Bundle

Flow Agents' deliver skill calls `publishDelivery`, which writes
`delivery/<task-slug>/trust.bundle` to the repository with `git add -f` during the
`record-release` step. This file carries the session's evidence and claims to CI so the
anchor can reconcile them. On pull requests the action selects the single changed
per-session bundle; the legacy flat path remains read-compatible during migration.

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
          # Use advisory only while the check is not yet required in branch protection.
          missing-bundle-policy: required
          # bundle: leave empty for ownership-aware discovery across legacy flat and
          # per-session delivery paths; set only for a deliberate explicit path
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

Use `missing-bundle-policy: advisory` only during a deliberate observation period before
arming the status check. Change it to `required` when the check becomes required. This
setting controls bundle absence only: a failed fresh verification still fails in either
mode.

## Step 4 — Protect the Verify Config

CODEOWNERS prevents the agent from quietly weakening the verify command. Add entries
for the files that declare what CI runs:

```
# Trust anchor config — requires owner review.
# An agent cannot weaken verify-command or the reconcile manifest without a human
# approving the change.
.github/workflows/trust-verify.yml  @your-org/owners
package.json                         @your-org/owners
evals/ci/run-baseline.sh             @your-org/owners
```

`package.json` covers both `trust-reconcile-verify` and the `trust-reconcile-manifest`
declaration (see below); `evals/ci/run-baseline.sh` covers the manifest registry when you
source the manifest from a `run-baseline.sh`-shaped registry. Adjust paths and team names
for your repo structure.

## Declaring a Manifest (Multiple Commands)

The single `trust-reconcile-verify` command above is the anchor's standalone fresh-verify
(and the legacy reconcile path — a manifest of size 1). To reconcile **granular,
per-acceptance-criterion** evidence — some commands, some session-local/manual/provider
evidence — declare a **reconcile manifest**: a set of named, individually-re-runnable
commands, each of which must actually run in a required CI lane (see ADR 0020).

Resolution priority (first match wins):

1. CLI `--manifest '<json>'`
2. `TRUST_RECONCILE_MANIFEST` environment variable (JSON)
3. `package.json` `"trust-reconcile-manifest"` — either an inline array, or a string
   command that emits the JSON:

   ```json
   {
     "trust-reconcile-manifest": [
       { "id": "unit",  "command": "npm test" },
       { "id": "lint",  "command": "npm run lint" },
       { "id": "types", "command": "npm run typecheck" }
     ]
   }
   ```

   Every `id`/`command` here must be a command your required CI actually runs. If your repo
   already has a lane registry that CI invokes, point the key at its machine-readable emit
   instead of duplicating it (this is what Flow Agents does — see the mirror section):

   ```json
   { "scripts": { "trust-reconcile-manifest": "bash evals/ci/run-baseline.sh --manifest-json" } }
   ```
4. `evals/ci/run-baseline.sh --manifest-json` (auto-detected, if present).

**How classification works.** A claim reconciles per-command against fresh CI results only
when its evidence is `evidenceType: "test_output"` **and** its command matches a manifest
entry. Honest session-local evidence (`human_attestation`, `crawl_observation`,
`document_citation`, `policy_rule`, `source_excerpt`, `attestation`) is never flagged
"not-run" for lacking a command — it is accepted on its Surface-derived `verified`/`assumed`
status. A `test_output` claim whose command is not in the manifest is still a divergence
(you cannot self-label an arbitrary command `test_output` to dodge the manifest).

**Session-local passes are loudly, not quietly, marked.** A non-command-backed claim that
re-derives `verified` (and carries no waiver) is NOT independently re-runnable by CI — the
anchor can only confirm the bundle is internally self-consistent, not that the underlying
attestation is true. It prints a distinct line for every such claim:

```
[trust-reconcile] ATTESTED (not independently verifiable at L0): '<claimId>' (<claimType>) evidenceType=<type> — accepted on bundle-internal consistency only; see ADR 0020 Residuals
```

plus a summary count (`N attested claim(s) accepted without independent verification`). This
does not change the exit code — attestations are not blocked, only disclosed — so review the
`ATTESTED` lines and count in any bundle before trusting it. See the **Residuals** section of
[ADR 0020](adr/0020-trust-reconcile-manifest-and-claim-classification.md) for the full
disclosure (fabricated self-consistent attestations, unauthenticated `approved_by`, and the
evidenceType-laundering route).

**Waiving an accepted gap.** For an honestly-accepted gap, record it with both flags:

```bash
npm run workflow:sidecar -- record-evidence <artifact-dir> --verdict pass \
  --check-json '{"id":"load-test","kind":"external","status":"skip","summary":"sustained-load perf test"}' \
  --accepted-gap-reason "load-test env not provisioned this cycle; tracked for the perf milestone" \
  --waived-by "your-name"
```

Both `--accepted-gap-reason` and `--waived-by` are required together — an accepted gap
with no justification or approver is refused (no silent waiver). Reuse a **separate**
`record-evidence` invocation for waived checks: the flags apply to every check in the
invocation. The anchor prints each waived claim on a distinct, un-suppressible
`[trust-reconcile] WAIVED: ...` line in the required job's own log — reviewed and visible,
never silent.

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

# Re-run verify + reconcile against a delivered bundle explicitly:
npx @kontourai/flow-agents verify \
  --commands "npm run build,npm test" \
  --bundle delivery/<task-slug>/trust.bundle

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
- **`package.json` `trust-reconcile-verify`** — `npm run build && npm run eval:static`
  (the standalone fresh-verify / legacy single-command reconcile path).
- **`package.json` `trust-reconcile-manifest`** — `bash evals/ci/run-baseline.sh
  --manifest-json` (the reconcile manifest *is* the live `run-baseline.sh` `LANE_*`
  registry — every entry runs in a required `ci.yml` lane by construction).
- **`evals/ci/antigaming-suite.sh`** — the regression suite that proves the gate and
  anchor work (including `test_trust_reconcile_manifest.sh` and the end-to-end
  `test_trust_reconcile_mixed_bundle.sh`); runs in the required `ci.yml` lane.
- **Branch protection** on `main` — `Trust Reconcile` required, `enforce_admins` on.

## Adoption Checklist

- [ ] Deliver skill is configured and publishes `delivery/<task-slug>/trust.bundle`.
- [ ] `.github/workflows/trust-verify.yml` added and the composite action is pinned.
- [ ] `verify-command` declares a comprehensive verify (build + tests + lint).
- [ ] `missing-bundle-policy` matches the adoption phase (`advisory` while observing,
      `required` before branch protection is armed).
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

**"command is not in the reconcile manifest"**: A `test_output` claim named a command that
is not a manifest entry. Either declare the command in your `trust-reconcile-manifest` (and
ensure it runs in a required CI lane), or, if the evidence is genuinely session-local
(manual/provider/observation), record it with a non-`test_output` `evidenceType` so it is
classified session-local instead of expected to be CI-re-runnable.

**"session-local claim ... asserts pass ... but has no waiver and no Surface-derived
verified/assumed status"**: An honest session-local claim must either resolve a real
`verified`/`assumed` Surface status from its own evidence, or be explicitly waived with
`--accepted-gap-reason` + `--waived-by`. Classification is not a pass bypass.

**"checkpoint-only bundle cannot be reconciled per-command"**: A `delivery/trust.bundle`
was expected but only `delivery/trust.checkpoint.json` was found. The deliver skill
publishes the full bundle; ensure it ran correctly.

**"ATTESTED (not independently verifiable at L0): ..."**: Not an error — the job still
passes. This is the anchor telling you a claim was accepted on bundle-internal consistency
only (no CI command to re-run and no independent, cryptographically-verified attestation).
Review each `ATTESTED` line and the summary count before trusting the bundle; see
[ADR 0020's Residuals section](adr/0020-trust-reconcile-manifest-and-claim-classification.md).
