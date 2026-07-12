---
name: "review-work"
description: "Report-only critique before Builder verification. Records a critique slice through the public workflow interface without claiming Flow completion."
---

# Review Work

## Role

This is a Builder step skill.

Review Work is the report-only critique step. It asks whether the changed work
should change before verification: correctness risks, maintainability, security,
dependencies, architecture, standards, and applicable policy.

It does not prove accepted behavior and it does not fix source files.

## Binding

| Context | Binding | Flow expectation |
| --- | --- | --- |
| Active Builder run | `builder.build` at `verify` | `clean-critique`. Review Work owns the critique claim, not verification completion. |
| Standalone invocation | No Flow binding | No workflow mutation. |

For an active run, inspect the binding before work:

```bash
flow-agents workflow status --session-dir <session-dir> --json
```

Run this skill only when the reported run is `builder.build` at `verify`.
If there is no matching active run, operate standalone. Do not publish a gate
expectation from this skill.

## Model Routing

Resolve `delegate-implementation` from `.datum/config.json` and follow
`context/contracts/execution-contract.md`. The Goodhart guard applies: review
must never resolve below the reasoning tier of the checked work. Record any
fallback or escalation in the critique artifact.

## Inputs

- Changed-file scope from the session, plan, or `RepositoryAdapter`.
- Acceptance criteria and implementation intent.
- Repository standards and relevant decisions.
- Available `CheckProvider` evidence and policy constraints.

## Review Work

1. Establish the changed-file scope. If it cannot be established, record the
   scope review as `NOT_VERIFIED`.
2. Select review lanes from the changed scope and risk, not from a fixed list
   run unconditionally:
   - `tool-code-reviewer` for code quality, correctness, architecture, and standards.
   - `tool-security-reviewer` for authentication, authorization, secrets,
     untrusted input, data handling, network boundaries, infrastructure, and
     security-policy changes.
   - `tool-dependencies-updater` for dependency-manifest, lockfile, or dependency-tooling changes.
   - A configured domain or policy reviewer when the repository requires one.
3. Use repository-provided scanners and checks when applicable. Do not install
   a scanner, silently substitute a different one, or mark an unavailable
   required lane clean; record the lane as `NOT_VERIFIED` with the missing
   capability and consequence.
4. Keep findings actionable: severity, affected scope, evidence, and the
   required route back. Do not install scanners or change code to obtain a
   cleaner result.
5. Produce the critique artifact. Open blocking findings route to implementation;
   unavailable required review remains `NOT_VERIFIED`.

## Output

For a matching active run, record the review through the public interface:

```bash
flow-agents workflow critique --session-dir <session-dir> \
  --verdict <pass|fail|not_verified> \
  --summary "Review scope, findings, and unresolved gaps are recorded." \
  --artifact-ref ".kontourai/flow-agents/<slug>/<slug>--deliver.md" \
  --artifact-ref "<reviewed-changed-file>" \
  --lane-json '{"id":"code-review","status":"pass","summary":"Code quality, correctness, architecture, and standards were reviewed.","evidence_refs":[{"kind":"artifact","file":".kontourai/flow-agents/<slug>/<slug>--deliver.md","summary":"Reviewed delivery artifact and changed-scope context."}]}'
```

The delegated reviewer must invoke this operation under its own runtime actor
identity. The public operation requires an active implementation assignment but
rejects the assigned implementation actor as the reviewer; do not proxy the
review through the implementation actor or supply a caller-selected reviewer
label. The critique is stored as the review slice in `trust.bundle`: reviewer
identity, covered scope, lane verdicts, severity-tagged findings, evidence, and
unresolved `NOT_VERIFIED` gaps. A clean critique satisfies the declared
`clean-critique` expectation, but it is not test evidence, does not satisfy
`tests-evidence`, and does not independently advance a Flow run.

Runtime actor separation is a coordination guarantee, not cryptographic
attestation. When repository policy requires an externally attested reviewer
credential and the runtime cannot provide one, record reviewer identity as
`NOT_VERIFIED`; do not describe the review as independently authenticated.

Every critique needs at least one substantive `--lane-json`. A passing critique
also needs existing local `--artifact-ref` values for the delivery report and
reviewed changed files. The writer hashes those files and captures the current
workspace snapshot in `review_target`. Git repositories bind the review to
`HEAD`, the tracked diff, and untracked file bytes; non-Git repositories bind it
to the explicitly reviewed files. A later implementation change makes the
critique stale rather than silently clean.

For standalone use, return the same report to the caller without creating a
workflow record.
