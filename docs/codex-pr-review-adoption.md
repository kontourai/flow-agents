---
title: "Builder Codex PR review — advisory adoption"
---

# Builder Codex PR review

The Codex PR review action is an optional `CheckProvider` producer for Builder
Kit's third stage. It reviews the published pull request at the composed
`builder.publish-learn` step `merge-ready-ci`; it does not replace the
pre-publication `review-work` critique at `verify`.

The three Builder stages stay distinct:

1. `builder.shape` turns an idea into ready backlog work.
2. `builder.build` pulls selected work, implements it, critiques it, verifies
   acceptance, and publishes a change.
3. `builder.publish-learn` observes the published exact head, reconciles CI and
   independent review, makes the merge/release/hold decision, and routes
   evidence-backed follow-up through `learning-review`.

## What the action proves

The action creates a `CodexPullRequestReview` artifact bound to repository, PR,
base SHA, head SHA, merge base, diff digest, model, reasoning effort, provider
action revision, run, and trigger actor. The runner—not the model—binds that
identity around the schema-constrained assessment.

The result remains probabilistic review evidence. It does not prove tests,
Veritas readiness, human authority, or correctness, and it cannot merge,
release, deploy, or modify the branch.

## Advisory workflow

Start advisory. Do not make the check required until its signal, coverage,
latency, and credential boundary have been measured in the adopting repository.

```yaml
name: Builder Codex PR review

on:
  pull_request:
    types: [opened, synchronize, reopened]

permissions:
  contents: read
  pull-requests: write

jobs:
  codex-review:
    runs-on: ubuntu-latest
    steps:
      - name: Check out the exact PR head
        uses: actions/checkout@df4cb1c069e1874edd31b4311f1884172cec0e10 # v6.0.3
        with:
          ref: ${{ github.event.pull_request.head.sha }}
          fetch-depth: 0
          persist-credentials: false

      - name: Review exact head
        id: review
        uses: kontourai/flow-agents/.github/actions/codex-pr-review@<PINNED_FLOW_AGENTS_SHA>
        with:
          openai-api-key: ${{ secrets.OPENAI_API_KEY }}
          github-token: ${{ github.token }}
          repository: ${{ github.repository }}
          pull-request: ${{ github.event.pull_request.number }}
          base-sha: ${{ github.event.pull_request.base.sha }}
          head-sha: ${{ github.event.pull_request.head.sha }}
          model: gpt-5.6-sol
          effort: xhigh

      - name: Retain the validated review result
        uses: actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a # v7.0.1
        with:
          name: builder-codex-pr-review-${{ github.event.pull_request.head.sha }}
          path: ${{ steps.review.outputs.result-file }}
          if-no-files-found: error
          retention-days: 30
```

`model` is caller policy. The example deliberately selects `gpt-5.6-sol`; the
Builder skill and action do not silently substitute a model. The official
OpenAI Codex action is pinned inside the Flow Agents action and runs with
`drop-sudo`, a read-only Codex sandbox, ephemeral state, and a schema-bound
output. The OpenAI key is passed only to that action input, never as job-wide
environment state. The GitHub token reaches only the later comment-publication
step.

For forked pull requests GitHub withholds repository secrets. The action does
not invoke Codex and emits `NOT_VERIFIED` for that exact head. Do not replace
this with `pull_request_target` plus an untrusted checkout. A trusted maintainer
may rerun through a separately reviewed approval path later.

## PR comments

The action publishes one advisory GitHub review per exact head when
`github-token` is supplied. Findings on changed right-side lines become inline
comments explaining what should change and why. Findings that GitHub cannot
attach to a changed line stay in the review summary with `file:line` evidence.
Comment publication is presentation only: a GitHub API failure warns but does
not rewrite the validated verdict.

## Route-back and repair

`release-readiness` consumes the validated artifact for the current PR head:

- `fail` with a blocking implementation finding records failed
  `ci-merge-readiness` evidence with route reason `implementation_defect`, so
  Flow routes `merge-ready-ci` back to `execute`;
- `not_verified` records failed readiness evidence with route reason
  `missing_evidence`, so the Builder run returns for fresh evidence;
- `comment` remains an explicit non-blocking finding that must be accepted,
  deferred, fixed, or otherwise disposed under repository policy;
- `pass` is review evidence only and still requires deterministic checks,
  governance, freshness, and merge authority.

GitHub Actions cannot wake an arbitrary local agent session. The current
Builder shepherd reads the provider result and follows Flow's `next_action` in
the already-bound worktree. A runtime such as Station may later implement a
continuation adapter that wakes that exact task and worktree. Automatic repair
must remain a separate implementation actor and workflow; the report-only
reviewer never edits its own findings away.

After the implementation actor pushes a fix, the head changes, the prior
review becomes stale, and the action reviews the new exact head. Learning
Review may file or link repository defects, missing standards, or Builder Kit
workflow gaps only when the evidence supports a durable follow-up.

## Station dogfood

Station is a useful first consumer, not the owner of this mechanism. Adopt the
workflow as advisory and do not add it to required checks during calibration.
A clean Sol review does not replace Station's canonical `full:regression`
receipt or physical platform evidence. Compare unique defects, false positives,
`NOT_VERIFIED` coverage, review latency, and repair rounds before changing
enforcement.
