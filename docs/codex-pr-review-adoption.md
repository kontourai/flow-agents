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

The model-facing assessment schema deliberately uses OpenAI's supported
Structured Outputs subset. Cross-field verdict, coverage, severity, and
required-change invariants are enforced again by the trusted runner before it
binds the public result; unsupported composition keywords are not sent to the
provider.

Codex itself runs from a fresh trusted temporary directory rather than the PR
checkout. The action sets `project_doc_max_bytes=0`, clears fallback instruction
filenames, and points the prompt at the source checkout as read-only data. This
prevents a PR-authored `AGENTS.md` or `AGENTS.override.md` from entering Codex's
instruction chain; the reviewer may inspect those files only as untrusted
repository content.

## Engines

The composite is engine-agnostic. `engine: codex` (the default) preserves the
original success-path behavior; `engine: kiro` runs the same exact-head
contract through a pinned `kiro-cli` headless session. Unknown engine names
fail closed at the prepare step.

Credentials are engine-scoped. For codex the generic `api-key` input takes
precedence over the compatibility alias `openai-api-key`. For kiro, `api-key`
is the only accepted credential: `openai-api-key` never reaches the Kiro
service, so legacy wiring plus `engine: kiro` cannot leak an OpenAI secret
cross-vendor — it records `reviewer_withheld` exactly like a missing key.

Two behavior changes apply to existing callers that pass only
`openai-api-key`, both deliberate:

- **A reviewer crash no longer reds the check.** The engine steps run with
  `continue-on-error`; a crashed or failed engine run publishes a validated
  `not_verified` result with `not_verified_reason: reviewer_unavailable`
  instead of failing the workflow. Callers that previously relied on a red
  check to notice reviewer breakage must gate on the `verdict` output (and
  `not_verified_reason` in the artifact) instead. One asymmetry is
  intentional: an engine run that *succeeds* but emits a parseable,
  schema-invalid assessment still hard-fails the composite at finalize —
  that is a contract violation worth a red check, not a quiet
  `NOT_VERIFIED`.
- **The result schema change is one-directional.** Artifacts produced by this
  version validate against this version's schema only: new skip results carry
  `not_verified_reason`, which the pre-change schema rejects under
  `additionalProperties: false`. Consumers that pin the old schema must
  upgrade it together with the action; old artifacts still validate against
  the new schema.

Both engines share every trust boundary except the sandbox, and that
difference is disclosed rather than papered over:

- **codex** executes inside the pinned official `openai/codex-action` with an
  OS-level read-only sandbox, `drop-sudo`, and provider-side schema
  enforcement of the assessment.
- **kiro** has no equivalent OS sandbox. Containment is CLI tool policy only:
  the run trusts the three read-only file tools, `fs_read` (the CLI's alias
  for `read`), `grep`, and `glob` — no shell, no write tools, no network
  tools, never blanket tool trust — the working directory is a trusted
  temporary directory so a PR-authored `.kiro/` configuration is never
  loaded, and the assessment is captured from the model's stdout response
  rather than written by the model. `grep` and `glob` have to be named: their
  default is "trust working directory", and the checkout is not the working
  directory, so under `--trust-tools=fs_read` non-interactive mode denied
  every search of the checkout (see the first-run findings below). None of
  the three is path-scoped: each reads whatever the runner user can read,
  which is the boundary `fs_read` alone already had — the change widens the
  tool list, not the filesystem reach, and no evidence here confines reads
  (or symlink following) to the checkout. Because `kiro-cli` cannot run git without shell trust, the
  prepare step materializes the exact merge-base diff as `diff.patch` for
  read-only inspection. A defect in the CLI's tool policy would not be caught
  by an OS sandbox; weigh that when choosing the engine.

The output channel differs too: codex's assessment is written by the pinned
action's harness under provider-side schema enforcement, while kiro's is
parsed out of a mixed stdout stream (the extractor anchors to the CLI's final
response marker and requires the assessment to be the stream's trailing JSON
suffix; anything else routes to `NOT_VERIFIED`). A stdout-parsed channel is
inherently weaker evidence of "the model said exactly this" than a
harness-written file; the strict finalize validation is the equalizer both
engines pass through.

What the first live kiro run showed (kontourai/station run 33571203065,
kiro-cli 2.20.2, `--trust-tools=fs_read`, the trusted empty cwd):

- The tool-policy binding holds: `fs_read` trusted `read`; `shell` and
  `write` stayed untrusted. But `grep` and `glob` were denied
  ("non-interactive mode (no user to approve)") because their default is
  "trust working directory" and the checkout is outside it. The model
  reported the gaps and finalize rejected the review (`coverage gaps
  require verdict not_verified or fail`). Measured locally with kiro-cli
  2.21.0 (`printf '/tools\n' | kiro-cli chat --no-interactive
  --trust-tools=<X>`): `fs_read,grep,glob` trusts exactly those three and
  leaves `shell`/`write` untrusted, which is what the run now passes. Two
  built-ins are outside the flag's control under every setting — `code`
  ("trust read-only operations") and `introspect` ("trusted") — both
  read-only.
- Tool denial traces went to the job log (stderr), not the captured stdout;
  the extractor found the assessment in the raw output.
- Still unverified: the extractor's ordering assumption (nothing untrusted
  follows the model's final reply on stdout), and what the service did with
  the caller's model id. Both need the raw output, which the composite does
  not retain and which a finalize rejection discards without a record —
  tracked as #1399. Until that lands, read the raw artifact of the first
  run that retains one before trusting the lane.

The kiro toolchain is pinned exactly: `scripts/ci/install-kiro-cli.sh`
downloads one immutable versioned artifact from the official Kiro CLI
distribution origin (the same origin `https://cli.kiro.dev/install` uses),
verifies a SHA-256 recorded in reviewed source, verifies the archive layout,
and verifies the installed binary reports the pinned version. It never fetches
`latest`, and a mismatch anywhere refuses to install.

Model and effort are caller policy for both engines. For kiro the model is
passed to `kiro-cli chat --model`, which refuses a model the service does not
offer (verified: an unknown model exits non-zero with an explicit error, no
silent substitution), so the artifact can never carry a model name the engine
did not accept. Kiro supports efforts `low` through `max`; `ultra` is
codex-only and fails closed at prepare.

Both engines produce the assessment through the same finalize validation and
the same public result schema. Provenance is engine-derived, never a fixed
label: `reviewer.runtime`, `reviewer.provider`, and
`reviewer.provider_revision` record the engine that actually ran (`codex` /
`openai/codex-action` / action revision, or `kiro` / `kiro-cli` / pinned CLI
version), and the schema couples those fields so a kiro review cannot validate
while labeled codex. The `role` field keeps the historical
`CodexPullRequestReview` type name for consumer compatibility;
`reviewer.runtime` is the authoritative engine record.

A failed or crashed engine run — install failure, CLI crash, refused model,
unparseable output — is routed to the NOT_VERIFIED recording instead of
failing the workflow, with `not_verified_reason: reviewer_unavailable`. A
withheld credential records `not_verified_reason: reviewer_withheld` as
before. Consumers can distinguish "no reviewer was authorized" from "the
reviewer broke" without parsing prose.

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
Every finding records `requires_change`; a medium finding with that flag is
blocking just like a high or critical finding and cannot be laundered through a
`comment` verdict.
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
