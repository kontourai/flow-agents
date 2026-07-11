---
name: "evidence-gate"
description: "Assess whether verification evidence and scope integrity support merge review. Produces a confidence report and Builder merge-readiness evidence."
---

# Evidence Gate

## Role

This is a Builder step skill.

Evidence Gate assesses whether the completed work has trustworthy, scoped
evidence for merge review. It does not fix code, publish a change, approve a
release, or deploy.

## Binding

| Context | Binding | Flow expectation |
| --- | --- | --- |
| Active Builder run | `builder.build` at `merge-ready` | `merge-readiness` |
| Standalone invocation | No Flow binding | No workflow mutation. |

For an active run, confirm the binding before evaluation:

```bash
flow-agents workflow status --session-dir <session-dir> --json
```

Only a matching run may publish `merge-readiness`. A standalone confidence
report is local and must not call `workflow evidence`.

## Inputs

- The relevant verification and critique slices in `trust.bundle`.
- Changed-file scope from `RepositoryAdapter` or the execution record.
- Change and check records from `ChangeProvider` and `CheckProvider` when available.
- Known risks, accepted gaps, and repository policy evidence.

## Evaluation

1. Operate report-only. Do not patch source, alter checks, publish a change, or
   rerun with weaker options to manufacture a passing decision.
2. Confirm acceptance evidence maps to the intended changed scope. Compare the
   planned scope, actual diff, generated files, and provider-reported change.
   Unexplained drift, weakened checks, or unrelated edits reduce confidence and
   must be named.
3. Classify evidence by strength: direct runtime or test observation; provider
   check/review record; reproducible command result; source inspection; or
   unsupported assertion. Preserve command, revision, timestamp, scope, and
   artifact provenance where available. Prose-only completion claims are not
   acceptance proof.
4. Re-run only when the command is safe, relevant, and reproducible. A stale,
   unavailable, changed, or non-reproducible check is degraded to
   `NOT_VERIFIED`; a previous pass must not remain current by assertion.
5. Produce `PASS`, `FAIL`, or `NOT_VERIFIED` for the confidence decision.
   `NOT_VERIFIED` is the result for missing required proof, unavailable provider
   information, or unresolved integrity questions.
6. On a matching active run, publish the decision through the public CLI:

```bash
flow-agents workflow evidence --session-dir <session-dir> \
  --expectation merge-readiness \
  --status <pass|fail|not_verified> \
  --summary "Evidence confidence, scope integrity, and remaining risks are recorded." \
  --evidence-ref-json '{"kind":"artifact","file":"<session-dir>/<slug>--evidence-gate.md","summary":"Evidence confidence, criterion coverage, and scope-integrity decision."}'
```

## Output

Record the confidence report as the `merge-readiness` slice in `trust.bundle`.
It contains the scope assessed, acceptance evidence, integrity findings,
evidence provenance, residual risks, `PASS`/`FAIL`/`NOT_VERIFIED` decision, and
recommended route.

Include a readable `Acceptance Evidence` table when behavior is claimed:

| AC id | Status | Command/Test Evidence | Source Evidence | Gaps |
| --- | --- | --- | --- | --- |

For a matching active run, publish that report as `merge-readiness`. This is a
merge-review confidence decision, not release or deployment authorization.
