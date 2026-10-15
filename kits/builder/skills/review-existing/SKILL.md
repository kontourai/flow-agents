---
name: "review-existing"
description: "Record an existing exact-head change as pre-existing implementation for a builder.review-existing or builder.deliver-existing run; no implementation claim."
---

# Review Existing

## Role

This is a Builder step skill for the `builder.review-existing` and
`builder.deliver-existing` flows.

It records that the change under review already existed before the run: an
open pull request or any other change at one exact Git commit. It produces the
`<slug>--existing-change.md` artifact and the `pre-existing-implementation`
expectation. It never implements, repairs, or edits source. The run has no
`execute` step, so it makes no implementation claim.

Use `builder.build` for new work. Use these flows only when the implementation
already exists. `builder.review-existing` stops after independent review and
verification of that exact head. `builder.deliver-existing` continues: it
adopts the change's open pull request, records CI readiness and learning at the
same head, and lets `merge-change` merge it (see Deliver And Merge below).

## Binding

| Context | Binding | Flow expectations |
| --- | --- | --- |
| Active existing-change run | `builder.review-existing` or `builder.deliver-existing` at `existing-change` | `pre-existing-implementation` |
| Standalone invocation | No Flow binding | No workflow mutation. |

The `builder.review-existing` steps are `pull-work`, `existing-change`,
`verify`, and `done`; `builder.deliver-existing` adds `pr-open`,
`merge-ready-ci`, and `learn` after `verify`.
`pull-work` produces `selected-work` as in `builder.build`. At `verify`,
`review-work` produces `clean-critique` and `verify-work` produces
`acceptance-criteria`, `tests-evidence`, and applicable `policy-compliance`
exactly as they do at `builder.build` `verify`.

## Start

1. Check out the exact commit under review in a clean Git worktree; the run
   refuses a dirty tree. If the reviewed head does not already ignore
   `.kontourai/` and `delivery/`, append both to the local exclude file, which
   does not change the head under review:
   `exclude="$(git rev-parse --git-path info/exclude)"; mkdir -p "$(dirname "$exclude")"; printf '.kontourai/\ndelivery/\n' >> "$exclude"`.
   That path also works in a linked worktree, where `.git` is a file. The
   exclude file is shared by all worktrees of the repository. Commit an ignore
   rule only if the repository wants it anyway: a commit makes a new head.
2. Complete `pull-work` selection, write
   `<session-dir>/<slug>--pull-work.md` naming the Work Item reference, and hold
   the assignment. The assignment holder is the implementation owner, normally
   the author of the change.
3. Use a provider reference (`owner/repo#numeric-id` or `provider:id`). A
   `local:` reference only resumes an existing `builder.shape` session and
   cannot start this flow; without a provider assignment, use a provider-style
   reference with `--assignment-provider local-file`.
4. In a linked Git worktree the default artifact root is the main checkout's
   store, so the pin would be compared with the main checkout's `HEAD`. Pass
   `--artifact-root "$(git rev-parse --show-toplevel)/.kontourai/flow-agents"`
   to `start` (write the pull-work report under that root), and give every later
   verb `--session-dir` under the worktree; without it a verb looks the session
   up through the main checkout's store, does not find it, and refuses.
5. Start the run with the head pinned:

```bash
flow-agents workflow start --flow builder.review-existing \
  --work-item <provider-ref> --assignment-provider <kind> \
  --source-head <40-hex commit>
```

(`--flow builder.deliver-existing` to deliver and merge the change.)

`--source-head` must be the full lowercase commit SHA of the checked-out HEAD.
The run persists it and re-checks it at every gate. A missing or malformed
head, a head that is not HEAD, or a dirty tree is refused before any session
artifact is written.

## Existing Change

Write `<session-dir>/<slug>--existing-change.md` with:

- the provider record of the change (for example the pull request URL; in a
  `builder.deliver-existing` run, the URL of the pull request it will adopt);
- the base ref and base commit;
- the exact head commit, equal to `--source-head`;
- the changed files, taken from the diff between base and head.

Do not reuse `<slug>--deliver.md` for this record; every session gets that file
as its session template, it is the Builder execution report in `builder.build`,
and review treats it specially. Then record the expectation:

```bash
flow-agents workflow evidence --session-dir <session-dir> \
  --expectation pre-existing-implementation --status pass \
  --summary "The change existed before this run at the pinned head; this run implements nothing." \
  --evidence-ref-json '{"kind":"provider","url":"<change-url>","summary":"Provider record of the existing change."}' \
  --evidence-ref-json '{"kind":"artifact","file":"<session-dir>/<slug>--existing-change.md","summary":"Base, exact head, and changed files of the existing change."}'
```

The writer stamps the claim with the captured Git snapshot, so the head is
observed rather than supplied by the caller. A claim recorded in a dirty tree
or at another commit cannot satisfy the gate.

In a `builder.deliver-existing` run, give exactly one `provider` evidence ref:
the pull request's URL. `pr-open` adopts a pull request only when its URL is
the one this claim names.

## Verify

Run `review-work` and `verify-work` as for `builder.build` `verify`:

- The critique must come from a reviewer whose runtime identity differs from
  the assignment holder. Pass `<slug>--existing-change.md` and the reviewed
  changed files as `--artifact-ref` values.
- `tests-evidence` must be command-backed (`--command`) and observed in the
  clean worktree at the pinned head.
- This flow has no `<slug>--plan-work.md` and no execution report; the
  `<slug>--deliver.md` that every session gets is only the session template.
  Where the `review-work` and `verify-work` examples cite those files, cite
  `<slug>--existing-change.md` instead; a reference to a missing file is
  refused.

## Defects And New Heads

There is no in-run repair, no `execute` step, and no `implementation_defect`,
`plan_gap`, or `decision_gap` route back. A failing verify claim routes the run
back to `verify` (at most three route-backs; a fourth failing visit blocks). Passing evidence
re-recorded at the same pinned head in the new visit, a fresh critique and
fresh `tests-evidence`, can complete it, which covers a flaky or mis-invoked
check. A real code fix is a new head: fix the change through `builder.build`,
or push a new commit and review it in a new run. Any excursion off the pinned
head needs a new run, even if the checkout returns to the pin. A new head
needs a new run under a new provider Work Item. The run is keyed by the Work
Item and archiving keeps its canonical record, so restarting
the same Work Item resumes the old run. Resuming with a different
`--source-head` is refused, including for a completed run.

## Deliver And Merge (`builder.deliver-existing`)

After `verify`, a `builder.deliver-existing` run delivers the same head. Every
gate still re-checks the pinned head, so stay on it until the run completes.

1. `pr-open`: adopt the change's open pull request. Have a local branch with
   the pull request's head branch name pointing at the pinned head, then run:

   ```bash
   flow-agents publish-change execute --session-dir <session-dir> \
     --head-ref <pull-request-branch> --base-ref <base-branch>
   ```

   It takes no `--title`, `--body`, or `--draft`: the pull request is adopted,
   never opened, and its title and body are never set or compared. It refuses
   unless the provider shows exactly one open pull request for that head and
   base, from a branch in the same repository, at the pinned head, and that
   pull request is the one the `pre-existing-implementation` claim names.
   `HEAD` must be the pinned head in a clean worktree.
2. At `merge-ready-ci`, produce `ci-merge-readiness` with `release-readiness`;
   at `learn`, produce `decision-evidence` and `learning-evidence` with
   `learning-review`, exactly as for a `builder.build` run. Those skills'
   binding tables name only `builder.build`; in this run they apply to its
   composed `builder.publish-existing` steps. Record CI readiness for the
   pinned head. Provisional delivery is refused for this flow, because a
   provisional delivery commit would move the pull request head off the pin.
3. After the run completes at `learn`, run `flow-agents workflow publish-delivery`
   (see below). Its checkpoint commit is the pinned head. Commit exactly
   `delivery/<slug>/` as one commit on the pull request branch and push it.
   That needs push rights to the pull request's branch in the same
   repository, and it starts one more CI round on the new head.
4. `flow-agents merge-change request` and `merge-change execute` merge that
   terminal head: the pinned head plus exactly the one delivery-only commit.
   They refuse if the pull request's head moved, if the checkpoint was sealed
   at another commit, or if the terminal commit carries any other change.

If a second session adopts the same pull request and pushes its own delivery
commit, the pull request head moves and the first session's merge refuses.
Nothing detects the second adoption earlier.

## Consumers And Gaps

- `flow-agents workflow publish-delivery` accepts a completed run; its
  checkpoint commit is the pinned head. It refuses unless every
  command recorded on a passing claim (for example `tests-evidence`) is in the
  repository's reconcile manifest. Unless the repository declares a valid one (`package.json` `trust-reconcile-manifest`, or
  `evals/ci/run-baseline.sh --manifest-json`), list the exact recorded
  `--command` text in `TRUST_RECONCILE_COMMANDS` (comma- or newline-separated;
  whitespace runs are collapsed before an exact match), for example
  `TRUST_RECONCILE_COMMANDS="npm test" flow-agents workflow publish-delivery --session-dir <session-dir> --json`.
  Adding a `package.json` script would change the reviewed head; when the head
  already defines `trust-reconcile-verify`, record `tests-evidence` with
  `--command "npm run trust-reconcile-verify"` instead. Its untracked `delivery/<slug>/` output
  makes the next pinned start in the same checkout refuse until `delivery/` is
  in the local exclude file (`git rev-parse --git-path info/exclude`) or the
  output is removed.
- `merge-change` refuses `builder.review-existing` runs by name: that flow
  binds no step to the publish-change operation. Merge through the provider's
  own controls, or use `builder.deliver-existing`.
- That the reviewer is not the change's author on the provider (for example
  the GitHub pull request author) is `NOT_VERIFIED`. The runtime enforces only
  that the reviewer differs from the assignment holder. For a
  `builder.deliver-existing` merge, the provider's approval policy applies
  (an approving review is required and GitHub forbids approving your own pull
  request); whether an approval given before the delivery commit still counts
  for the terminal head depends on the repository's dismiss-stale-reviews
  setting.
- In a `builder.review-existing` run, that `--source-head` is the change's
  actual head on the provider is `NOT_VERIFIED`; nothing compares it with the
  pull request. A `builder.deliver-existing` run checks it when `pr-open`
  adopts the pull request, not at start. The base and changed files in
  `<slug>--existing-change.md` are written by the caller and are
  `NOT_VERIFIED`.
- `acceptance.json` is not anchored to a planning step in this flow.
