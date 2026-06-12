# Claim Fixtures

These trust-report JSON files are used by `.github/workflows/kit-gates-demo.yml` to prove
agentless gate evaluation against the `release-evidence` Flow Kit.

| File | Purpose |
| --- | --- |
| `pass-trusted-release.trust.json` | Passing case: `release.evidence` claim with status `trusted`. Gate verdict: `pass`. |
| `fail-rejected-release.trust.json` | Failing case: `release.evidence` claim with status `rejected`. Gate verdict: `route-back` or `block`. The workflow asserts the failure is detected (non-zero exit) rather than letting it silently pass. |

## Format

Each file is a Surface trust-report artifact (`artifact_type: "trust-report"`).
The Flow CLI normalizes these via `flow attach-evidence --trust-artifact` before gate evaluation.
