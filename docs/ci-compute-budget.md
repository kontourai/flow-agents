---
title: CI Compute Budget
---

# CI Compute Budget

Flow Agents uses two repository-wide native job concurrency groups:
`flow-agents-compute-1` and `flow-agents-compute-2`. Every participating job
sets `queue: max` and `cancel-in-progress: false`. The names contain no PR,
ref, head, run or attempt identifier. Admission happens in GitHub Actions,
before a runner is assigned; there is no runner-held acquisition loop.

## Participating inventory

| Workflow | Caller job or matrix child | Slot | Expanded runners |
| --- | --- | --- | --- |
| CI | secret-scan | 1 | gitleaks (1) |
| CI | source-and-static | 2 | 1 |
| CI | workflow-contracts | 1 | 1 |
| CI | runtime-and-kit | 2 | 1 |
| CI | integration-coverage | 1 | 1 |
| CI | usage-feedback | 2 | 1 |
| CI | windows-hook-smoke | 1 | 1 |
| Runtime Compatibility | harness-canary / opencode | 1 | 1 |
| Runtime Compatibility | harness-canary / pi | 1 | 1 |
| Runtime Compatibility | framework-sdk-canary | 2 | 1 |
| Runtime Compatibility | report (failure only) | 1 | 1 |
| Veritas Advisory Governance | readiness (full existing readiness) | 2 | 1 |
| Docs | gate | 1 | docs-gate (1) |
| Docs | pages (push/manual only) | 2 | build then deploy (2 sequential) |
| Kit Gates Demo | release-evidence-gate-demo | 1 | 1 |

This is 15 admission units covering 16 expanded runner jobs. At most one
admission unit runs in each slot, and each unit holds at most one runner at a
time. Therefore the participating peak across **all PRs and compatibility
runs together** is `1 × 1 + 1 × 1 = 2` runners. Matrix children each contend
for their assigned slot; a per-run `max-parallel` would not establish this
repository-wide bound. A caller holding a slot while Pages changes stages
can reduce utilization, but cannot increase the peak.

The security scan, docs gate and Pages callees are pinned to shared-workflow
commit `fd058ed6fcc780d60cc22e26d8c327281a197932`. Full Veritas readiness retains
its existing `ea4c99c803a565f56cd18abbf9041f3467d1ee93` pin. Exact downloaded
callee snapshots and SHA-256 digests are retained under
`evals/fixtures/ci-compute/`. These are evidence fixtures, not alternative
workflow implementations. The source validator rejects mutable or unknown
pins, nested reusable calls, matrices in callees, and any pair of callee jobs
without an ordering dependency. Pages' separate deployment concurrency group
does not match either caller slot, avoiding same-group caller/callee nesting.
Updating a pin requires retaining and reviewing its new expansion.

The bound applies to runs using these workflow revisions. Already-created runs
and older PR workflow revisions are not retroactively enrolled. During rollout,
legacy work can overlap the participating jobs and exceed two total runners;
this source change alone is not proof of a live repository-wide ceiling.
This is a cooperative repository source policy, not an organization security
boundary: a writer who can change workflows can also propose changing the budget.
Regression checks reject candidate bypasses; they cannot remove already-admitted
legacy jobs.

## Queue and cancellation limits

GitHub allows one running admission and up to 100 pending entries per group.
FIFO is by arrival at that group, not PR creation time or workflow start time.
An additional entry at a full queue is cancelled; that is a nonpassing result,
not evidence that its checks ran. Each group orders independently. This does
not promise globally balanced service, equal PR shares, or a maximum wait.
A busy slot can have a backlog while the other is idle.

CI retains its existing per-ref workflow concurrency and latest-head
cancellation. A new CI run can cancel older CI work for the same ref, including
a same-head duplicate; there is no new controller or exact-once guarantee.
Docs, readiness and demo retain their existing duplicate/cancellation behavior.
Shared slot groups never cancel another PR to make space. Cancellation and
runner teardown remain platform behavior requiring hosted observation.

## Explicit exclusions

The `publish-npm.yml` verification and publication jobs, the `release-please.yml`
release controller, and the `add-to-project.yml` issue automation caller are
outside this participating budget. They retain their existing ownership and
triggers. Total repository compute, organization capacity, and other repositories
can exceed two. This policy reserves no organization slots and requires no paid
capacity. A new workflow or job fails classification until its participation or
exception is reviewed; the current excluded workflows cannot acquire PR triggers
without changing the policy.

## Validation and remaining proof

`bash evals/static/test_ci_compute_policy.sh` runs through the existing static
suite and required CI evidence path. It validates original YAML, immutable
callee expansion, all matrix children, and mutation cases for a third group,
ref splitting, missing jobs/admission/queue, cross-PR cancellation, mutable pins,
unclassified PR compute and callee growth. Its finite model exhausts every
completion interleaving in 12 scenarios containing two PR graphs and runtime
compatibility, with both job orders and all six caller-batch arrival orders.
Separate model cases cover FIFO, overflow, duplicate work and cross-head
cancellation. This is bounded model evidence, not exhaustive platform evidence.

For local workflow syntax validation run `node scripts/ci/actionlint-compute.mjs`
with actionlint installed. The compatibility path validates the complete known
admission shapes on original YAML, then removes only their `queue` properties
from private temporary lint copies for actionlint 1.7.12. Workflow expressions,
needs, matrix and reusable-call keyword validation still run. It does not edit
the source or rewrite arbitrary unknown queue shapes. Security and policy checks
always consume original YAML. No extra dependency engine is introduced.

GitHub documents [job concurrency](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#jobsjob_idconcurrency)
and [concurrency on reusable calls](https://docs.github.com/en/actions/reference/workflows-and-actions/reusing-workflow-configurations#supported-keywords-for-jobs-that-call-a-reusable-workflow).
Source/schema/model checks do not prove runner admission on the hosted platform.
**Hosted job-level queue admission for this Flow policy is NOT_VERIFIED** until
candidate runs demonstrate cross-PR and matrix/reusable waiting before runner
assignment. No dispatch, unchanged-head rerun or auto-merge arming is needed to
prepare this policy. Existing required check names, evidence scopes, security
permissions, triggers and checkout identities remain intact.
