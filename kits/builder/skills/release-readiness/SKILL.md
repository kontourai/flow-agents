---
name: "release-readiness"
description: "Make a provider-neutral merge, release, deploy, or hold decision. Records Builder publish-learn CI merge-readiness in trust.bundle."
---

# Release Readiness

## Role

This is a Builder step skill.

Release Readiness turns confidence and published-change evidence into an explicit
`MERGE`, `RELEASE`, `DEPLOY`, `HOLD`, or `ROLLBACK_REQUIRED` decision. It does
not fix code, publish a change, or deploy without explicit authorization.

## Binding

| Context | Binding | Flow expectation |
| --- | --- | --- |
| Active Builder run | Parent `builder.build` projection at composed `builder.publish-learn` step `merge-ready-ci` | `ci-merge-readiness` |
| Standalone invocation | No Flow binding | No workflow mutation. |

For an active run, confirm the binding before making the Flow claim:

```bash
flow-agents workflow status --session-dir <session-dir> --json
```

Public status reports the parent definition as `builder.build`. Only that parent
run at `merge-ready-ci`, whose Flow Definition composes the step from
`builder.publish-learn`, may publish `ci-merge-readiness`.

## Inputs

- The evidence-gate confidence report and acceptance evidence.
- Published-change state from `ChangeProvider` and repository scope from
  `RepositoryAdapter`.
- Check and review state from `CheckProvider`.
- Release and deployment capabilities from `ReleaseProvider` and `DeployProvider`.
- Risk, rollback, observability, ownership, and authorization information.
- Repo-local governance evidence when `.veritas/repo-map.json` is present. The
  stable input is the `software-readiness-verdict` claim in the trust bundle
  written by `veritas readiness`; do not inspect or reproduce Veritas policy
  evaluation inside Builder Kit.

No provider is assumed. A change record, check, release record, or deployment
record may be unavailable because the repository or provider does not offer it.
Record the capability and its impact rather than substituting provider-specific
terms or treating absence as success.

## Decision Work

1. Confirm the confidence report remains applicable to the proposed scope.
2. Reconcile current provider checks and review state with the revision covered
   by acceptance evidence. Stale or mismatched evidence is `NOT_VERIFIED`.
   When the repository has `.veritas/repo-map.json`, run the pinned Veritas
   engine for the same base/head revision (prefer
   `npm exec --yes --package=@kontourai/veritas@1.5.2 -- veritas readiness
   --check evidence --changed-from <base> --changed-to <head> --format json`),
   follow its returned `reportArtifactPath`, and record the
   `software-readiness-verdict` claim plus that artifact reference in
   `release.json`. If the Veritas Governance Kit is active, its
   `veritas-governance.readiness-check` flow may supply the same claim as a
   gate-ready trust bundle. Never parse console prose or import Veritas runtime
   internals.
   During an explicitly recorded Observe/advisory rollout, a rejected or
   unavailable governance verdict is a visible residual risk and
   `NOT_VERIFIED` gap, not an automatic Builder `HOLD`. Once the repository has
   separately promoted Veritas governance to blocking enforcement, a missing,
   stale, or non-verified verdict is required evidence and therefore routes to
   `HOLD`.
3. Evaluate change publication, release and deployment implications through the
   available providers. Before `RELEASE` or `DEPLOY`, require an owner, an
   executable rollback or recovery path, observable success and failure
   signals, and a bounded post-release or post-deploy verification plan.
4. Require explicit authorization for merge, release, deploy, or rollback.
   Readiness evidence and an available provider capability are not authority to
   perform the operation.
5. Use `HOLD` for unresolved required evidence, ownership, rollback,
   observability, post-operation verification, or authority. Use
   `NOT_VERIFIED` for evidence that cannot be collected; it cannot be promoted
   to a clean merge, release, or deploy decision without an explicit accepted gap.
   Use `ROLLBACK_REQUIRED` when observed outcomes cross the recorded rollback
   threshold.
6. On a matching active run, publish the resulting evidence through the public
   CLI:

```bash
flow-agents workflow evidence --session-dir <session-dir> \
  --expectation ci-merge-readiness \
  --status <pass|fail|not_verified> \
  --summary "Release-readiness decision and residual risks are recorded." \
  --evidence-ref-json '{"kind":"artifact","file":"<session-dir>/release.json","summary":"Release-readiness decision, authorization, rollback, and observability state."}'
```

## Output

Record the decision as the `ci-merge-readiness` slice in `trust.bundle`. It
includes assessed scope, confidence evidence, provider capability and check
state, risks, rollback and observability plan, required authorization, and
unresolved `NOT_VERIFIED` gaps. For release or deployment decisions, also record
the owner, success/failure signals, rollback threshold, and post-operation
verification commands or observations.

When acceptance behavior is summarized, include a readable `Acceptance
Evidence` table:

| AC id | Status | Command/Test Evidence | Source Evidence | Gaps |
| --- | --- | --- | --- | --- |

The claim supports the next Builder step; it does not itself merge, release, or
deploy anything.
