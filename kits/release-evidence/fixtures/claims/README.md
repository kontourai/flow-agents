# Claim Fixtures

These trust-bundle JSON files are used by `scripts/ci/release-evidence-gate-demo.sh`
(run by `.github/workflows/kit-gates-demo.yml`) to prove agentless gate evaluation
against the `release-evidence` Flow Kit.

| File | Purpose |
| --- | --- |
| `pass-trusted-release.trust.json` | Passing case: `release.evidence` claim whose events derive status `verified`. Gate verdict: `pass`. |
| `fail-rejected-release.trust.json` | Failing case: `release.evidence` claim whose events derive status `rejected`. Gate verdict: `route-back`. The demo asserts that `evaluate --exit-code` exits non-zero and that the gate's claim diagnostic is `rejected`, so a fixture that fails for another reason does not count. |

## Format

Each file is a Hachure trust bundle (`schemaVersion`, `source`, `claims`, `evidence`,
`policies`, `events`). The demo attaches it with
`flow attach-evidence --kind trust.bundle`; Flow validates it against the Hachure
schema and derives each claim's status with Surface before gate evaluation.

Run the demo locally after installing the repository's pinned dependencies:

```bash
bash scripts/ci/release-evidence-gate-demo.sh
```

The bundle fields are fixed demonstration data. Real release evidence must be
emitted for the candidate being released.
