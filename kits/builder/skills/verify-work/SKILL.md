---
name: "verify-work"
description: "Report-only acceptance verification. Records command-backed Builder verification evidence in trust.bundle when bound to an active run."
---

# Verify Work

## Role

This is a Builder step skill.

Verify Work proves acceptance criteria with reproducible evidence. It is
report-only: verifiers may inspect, test, and write evidence artifacts, but do
not patch source files or apply autofixes.

Critique belongs to `review-work`; behavior proof belongs here.

## Binding

| Context | Binding | Flow expectations |
| --- | --- | --- |
| Active Builder run | `builder.build` at `verify` | `acceptance-criteria` and `tests-evidence`; `policy-compliance` only when applicable. `review-work` separately produces `clean-critique`. |
| Standalone invocation | No Flow binding | No workflow mutation. |

For an active run, verify the binding first:

```bash
flow-agents workflow status --session-dir <session-dir> --json
```

Only a matching active `builder.build` run at `verify` may receive workflow
evidence. Otherwise, return the verification report and unresolved gaps without
calling `workflow evidence`.

## Model Routing

Resolve `delegate-implementation` from `.datum/config.json` and follow
`context/contracts/execution-contract.md`. The Goodhart guard applies:
verification must never resolve below the reasoning tier of the checked work.
Record any fallback or escalation in the verification report.

## Inputs

- Acceptance criteria, Definition Of Done, and stop-short risks.
- Changed-file scope from the session, plan, or `RepositoryAdapter`.
- Local checks and runtime evidence selected for the change.
- Relevant `CheckProvider` and `ChangeProvider` evidence when it exists.
- The `trust.bundle` critique slice when review is required; critique findings
  remain separate from verification evidence.

## Verification Work

1. Re-check Goal Fit before testing: compare the delivered artifacts and actual
   changed scope with the selected Work Item, Definition Of Done, acceptance
   criteria, and stop-short risks. Missing requested behavior or unexplained
   scope routes back even when the implementation plan was completed.
2. Map each acceptance criterion to an observable check, source inspection, or
   runtime observation. Delegate to `tool-verifier`; include `tool-playwright`
   for browser-facing behavior.
3. Run relevant build, type, lint, test, security, diff, browser, runtime, and
   provider checks. `CheckProvider` evidence is provider-neutral; a provider
   check is not assumed to exist for every repository.
4. Record every criterion as `PASS`, `FAIL`, `NOT_VERIFIED`, or an explicitly
   accepted gap. Missing, inaccessible, or inconclusive evidence is
   `NOT_VERIFIED`, never `PASS`.
   Reject prose-only claims and non-resolving references. Evidence references
   must identify a command result, source location, provider record, runtime
   observation, or artifact that a reviewer can inspect. A passing
   `tests-evidence` claim needs every declared criterion exactly once, and every
   passing criterion needs a `kind:"command"` reference whose command text
   exactly matches one of the substantive `--command` values that ran
   successfully. External-only attestations cannot satisfy it.
5. Publish the relevant active-run expectation through the public CLI with one
   or more exact commands that produced the test results. Repeat `--command`
   when criteria require different checks, and include a matching top-level
   `--evidence-ref-json` for every recorded command. A prose summary or an
   artifact reference alone cannot satisfy `tests-evidence`:

```bash
flow-agents workflow evidence --session-dir <session-dir> \
  --expectation tests-evidence \
  --status <pass|fail|not_verified> \
  --command "npm test" \
  --summary "The recorded test command supports the accepted behavior." \
  --evidence-ref-json '{"kind":"command","excerpt":"npm test","summary":"Exact substantive project test command recorded for this verification result."}' \
  --criterion-json '{"id":"<criterion-id>","status":"pass","evidence_refs":[{"kind":"command","excerpt":"npm test","summary":"Exact substantive project test command run for this criterion."}]}' \
  --evidence-ref-json '{"kind":"artifact","file":"<session-dir>/<slug>--plan-work.md","summary":"Accepted criterion and planned verification mapping."}'
```

When a policy check applies, publish `policy-compliance` in the same way. Do
not publish that optional expectation when no policy check applies.

## Output

Record completed criteria as the required `acceptance-criteria` slice and the
verification result as the `tests-evidence` slice in `trust.bundle`.
It must preserve criterion identifiers and include a readable `Acceptance
Evidence` table in its summary or linked reviewable report:

| AC id | Status | Command/Test Evidence | Source Evidence | Gaps |
| --- | --- | --- | --- | --- |
| `<id>` | `PASS`, `FAIL`, or `NOT_VERIFIED` | Command, result, or observation | File, test, provider, or runtime reference | Missing or accepted evidence |

The result states the overall verification verdict and every unresolved gap.
For an active matching run, publish one `--criterion-json` object for every
accepted criterion, each with its own status and reviewable evidence refs, plus
a substantive literal `--command` for every distinct check that was run. Every
top-level and criterion command reference must exactly match one of those
commands. The public evidence calls
publish `acceptance-criteria`, `tests-evidence`, and applicable
`policy-compliance`; no retired
verification sidecar is a store. Never publish a placeholder, `true`,
`bash -c true`, or `node --version` as behavior evidence. In a packed or
temporary consumer repository, use a real project-local test/check/verify
script rather than a command that exists only in the Flow Agents source repo.
