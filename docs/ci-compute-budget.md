---
title: CI Compute Budget
---

# CI Compute Budget

Flow Agents has **no repository-wide job-level compute cap**. No participating
job sets `concurrency`. The only concurrency control is each workflow's own
top-level, per-ref group with `cancel-in-progress: true`, so a new push
supersedes the older run of the **same ref** and never another branch's run:

| Workflow | Workflow-level group |
| --- | --- |
| CI | `flow-agents-ci-${{ github.ref }}` |
| Docs | `flow-agents-docs-${{ github.ref }}` |
| Kit Gates Demo | `flow-agents-kit-gates-demo-${{ github.ref }}` |
| Runtime Compatibility | `flow-agents-runtime-compat-${{ github.ref }}` |
| Veritas Advisory Governance | `veritas-advisory-${{ github.ref }}` |

Each group embeds only `github.ref`, always with `cancel-in-progress: true`.
Runs from different refs do not share a group (GitHub compares group names
case-insensitively, so two refs differing only by case would), so concurrent PRs
run side by side; the platform's own runner limits are the only ceiling. The one
shared group left is the Pages callee's own deployment group, which belongs to
the pinned callee and not to this policy.

Action version updates preserve this admission model: CI uploads use
`actions/upload-artifact` 7.0.2, pnpm setup uses `pnpm/action-setup` 6.1.1 and
Runtime Compatibility setup uses `actions/setup-python` 7.1.0, with the existing workflow groups, runner inventory
and permissions. A version bump does not establish that a hosted run completed.

## Why there is no cap

The repository previously bounded participating compute with native job-level
concurrency groups using `queue: max`: first two groups
(`flow-agents-compute-1` and `-2`, each admitting one job), then, after a stall
on 2026-11-03, four (`flow-agents-compute-v2-{1,2}-{a,b}`, a lane chosen by
run-ID parity). Admission stalled repeatedly on 2026-11-03 and 2026-11-04. A
stalled queue head blocked every participating run for about an hour, and after
the groups were renamed and widened, runs still sat `pending` for roughly 25
minutes while every group in their lane was empty and only one job ran
repository-wide. Cancelling superseded runs did not restore admission. A shared
queue that can stall by itself turns one bad run into a repository-wide outage.

The repository is public, so GitHub-hosted minutes are free. The cap protected
no cost, and its failure mode cost far more than it saved. The owner therefore
decided (2026-11-04) to remove all job-level concurrency and keep only per-ref
supersession, which also stops superseded commits from occupying runners (the
Veritas advisory workflow now has the same per-ref group as CI).

This changes the earlier guarantee: there is no bound on concurrent
participating runners other than the platform's. Runs created under older
workflow revisions may still sit `pending` in the retired
`flow-agents-compute-*` groups; they are not retroactively released by this
change and can be cancelled.

## Participating inventory

| Workflow | Job or matrix child | Expanded runners |
| --- | --- | --- |
| CI | secret-scan | gitleaks (1) |
| CI | source-and-static | 1 |
| CI | workflow-contracts | 1 |
| CI | runtime-and-kit | 1 |
| CI | integration-coverage | 1 |
| CI | usage-feedback | 1 |
| CI | windows-hook-smoke | 1 |
| Runtime Compatibility | harness-canary / opencode | 1 |
| Runtime Compatibility | harness-canary / pi | 1 |
| Runtime Compatibility | framework-sdk-canary | 1 |
| Runtime Compatibility | report (failure only) | 1 |
| Veritas Advisory Governance | readiness (full existing readiness) | 1 |
| Docs | gate | docs-gate (1) |
| Docs | pages (push/manual only) | build then deploy (2 sequential) |
| Kit Gates Demo | release-evidence-gate-demo | 1 |

This is 15 participating jobs (counting matrix children) covering 16 expanded
runner jobs. The inventory remains a reviewed classification rather than a
bound: a new workflow or job fails the policy check until its participation or
exclusion is classified, so growth stays visible in review.

Promptfoo offline compatibility is a step inside the existing Workflow Contracts
job. Its verification command is registered in the baseline check inventory,
the workflow-contracts lane and that job's steps together.

The delegation rounds public-contract check is a step in Source and Static,
registered as `delegation-rounds-public-contract` in the baseline inventory and
that lane. It runs the rounds owner tests with the shared unit-test state
preload. The existing lane finalizer still determines success from its recorded
checks; `continue-on-error` on an individual step does not turn a failed check
into passing lane evidence.

The shipped runtime dependencies check is also a step in Source and Static,
registered as `shipped-runtime-dependencies`. It builds the package, then fails
when a published file imports a package the manifest does not declare for
consumers, and runs that guard's rejection-path tests.

The security scan, docs gate, Pages and full Veritas readiness callees are pinned
to shared-workflow commit `a5a3d3e6a93f4bdb6017164a1917507394b6912c`. That
readiness callee accepts an optional `runner-image` input; this repository does
not set it, so the job keeps its `ubuntu-latest` default. Exact downloaded
callee snapshots and SHA-256 digests are retained under
`evals/fixtures/ci-compute/`. These are evidence fixtures, not alternative
workflow implementations. The source validator rejects mutable or unknown
pins, nested reusable calls, matrices in callees, any pair of callee jobs
without an ordering dependency, and any callee `concurrency` other than Pages'
own deployment group, so a pinned callee cannot reintroduce a shared queue.
Updating a pin requires retaining and reviewing its new expansion.

The Docs gate explicitly selects Corpus revision
`b127e35a818b532369843731b3c64792baade83e` through the callee's
`corpus-ref` input. Local `npm run docs:check` and `npm run docs:build` use that
same revision. This changes source-bound freshness review behavior without
changing the callee snapshot, runner expansion, permissions or concurrency.
PR and merge-group checks are strict against their base: unchanged covering
prose requires a new complete local source/document byte review under the
[review contract](https://github.com/kontourai/corpus/blob/b127e35a818b532369843731b3c64792baade83e/docs/related-content.md#review-an-unchanged-covering-document).
One exception: a pull request run that Dependabot itself triggered on a pull request
Dependabot opened reports stale documents without failing (`advisory-freshness`).
Dependabot cannot write that review, and every Dependabot change touches a covered
input (`package.json`, `pnpm-lock.yaml` or a workflow), so the strict check failed on
every one of them. The stale documents are still listed in the job log. Any other actor's
push to such a branch, every human pull request, merge group and push to `main` remain
strict, and a superseding pull request that carries the same bump must still record the
review or update the prose.
Pages retains its independently pinned build and deployment implementation;
this gate selection does not qualify publication.

## Job execution deadlines

Source and Static has a 30-minute deadline, matching Runtime and Kit. In
[run 39605314051](https://github.com/kontourai/flow-agents/actions/runs/39605314051/job/119239881007)
at `82ddfaa6018aa46a03656fbda9de31d6a530e9cf`, static eval passed in 10m43s,
but the job reached Transition log at 14m59s and exhausted its former
15-minute deadline. Gate scorecard, Run pulse and Knowledge integration were
skipped; evidence finalization then failed on the incomplete lane.

The remaining checks took 23 seconds in the preceding successful main
[run 39114040325](https://github.com/kontourai/flow-agents/actions/runs/39114040325/job/117636033558),
with about two more seconds for finalization and upload. Combining those
measurements projects roughly 15m24s, leaving about 14m36s under the new limit.
This is a budget estimate, not proof that the repaired head passes hosted CI.

## Cancellation

CI, Docs, Kit Gates Demo, Runtime Compatibility and Veritas advisory each cancel
an older in-progress or pending run of the same ref when a new run starts for
that ref, including a same-head duplicate; there is no exact-once guarantee. A
push to `main` supersedes an older in-progress `main` run of the same workflow.
For Docs this can cancel the build or the deployment of the superseded commit:
the callee's own `cancel-in-progress: false` deployment group does not stop its
parent run being cancelled, and the deploy action cancels an active deployment
on a cancellation signal. If the replacement run then fails its docs gate,
nothing is published until a later successful run, so a stale site is possible
in that window. Merge-queue runs use unique refs and are never cancelled by
other entries. Cancellation and runner teardown remain platform behavior requiring hosted
observation.

## Explicit exclusions

The `publish-npm.yml` verification and publication jobs, the `release-please.yml`
release controller, and the `add-to-project.yml` issue automation caller are
outside the participating inventory. They retain their existing ownership,
concurrency and triggers. A new workflow or job fails classification until its
participation or exception is reviewed; the current excluded workflows cannot
acquire PR triggers without changing the policy.

## Validation

`bash evals/static/test_ci_compute_policy.sh` runs through the existing static
suite and required CI evidence path. It validates original YAML, immutable
callee expansion and all matrix children. The policy is the inverse of the
earlier admission rule:

- every participating workflow has exactly its pinned per-ref group with
  `cancel-in-progress: true`; a missing group, `cancel-in-progress` false,
  omitted or non-boolean, a group not keyed on `github.ref` alone, or an
  extra key is refused;
- no participating job has `concurrency` of any shape, including the retired
  `flow-agents-compute-*` names, `queue`, a bare string or an empty block. The
  tests reintroduce one on every participating job and require the refusal;
- unclassified workflows or jobs, PR triggers on excluded workflows, matrix
  growth, mutable callee pins and callee concurrency are refused.

The checker CLI compares real paths for its entry-point guard, so a symlinked
invocation path cannot make it skip validation silently.

For local workflow syntax validation run `node scripts/ci/actionlint-compute.mjs`
with actionlint installed. It runs the policy on the original YAML, then
actionlint on the real workflow files: no workflow uses a key actionlint cannot
parse, so no lowered copies are made. Workflow expressions, needs, matrix and
reusable-call keyword validation run.

GitHub documents [workflow and job concurrency](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#concurrency).
Source checks do not prove hosted run start latency; that is confirmed by
observing candidate runs start promptly. Existing required check names, evidence
scopes, security permissions, triggers and checkout identities remain intact.
