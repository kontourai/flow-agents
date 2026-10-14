---
name: "review-existing"
description: "Record an existing exact-head change as pre-existing implementation for a builder.review-existing run; no implementation claim."
---

# Review Existing

## Role

This is a Builder step skill for the `builder.review-existing` flow.

It records that the change under review already existed before the run: an
open pull request or any other change at one exact Git commit. It produces the
`<slug>--existing-change.md` artifact and the `pre-existing-implementation`
expectation. It never implements, repairs, or edits source. The run has no
`execute` step, so it makes no implementation claim.

Use `builder.build` for new work. Use this flow only when the implementation
already exists and the remaining work is independent review and verification of
that exact head.

## Binding

| Context | Binding | Flow expectations |
| --- | --- | --- |
| Active existing-change run | `builder.review-existing` at `existing-change` | `pre-existing-implementation` |
| Standalone invocation | No Flow binding | No workflow mutation. |

The flow's steps are `pull-work`, `existing-change`, `verify`, and `done`.
`pull-work` produces `selected-work` as in `builder.build`. At `verify`,
`review-work` produces `clean-critique` and `verify-work` produces
`acceptance-criteria`, `tests-evidence`, and applicable `policy-compliance`
exactly as they do at `builder.build` `verify`.

## Start

1. Check out the exact commit under review in a clean Git worktree. Workflow
   artifacts under `.kontourai/` must be gitignored, because the run refuses a
   dirty tree.
2. Complete `pull-work` selection and hold the assignment. The assignment
   holder is the implementation owner, normally the author of the change.
3. Start the run with the head pinned:

```bash
flow-agents workflow start --flow builder.review-existing \
  --work-item <provider-ref> --assignment-provider <kind> \
  --source-head <40-hex commit>
```

`--source-head` must be the full lowercase commit SHA of the checked-out HEAD.
The run persists it and re-checks it at every gate. A missing or malformed
head, a head that is not HEAD, or a dirty tree is refused before any session
artifact is written.

## Existing Change

Write `<session-dir>/<slug>--existing-change.md` with:

- the provider record of the change (for example the pull request URL);
- the base ref and base commit;
- the exact head commit, equal to `--source-head`;
- the changed files, taken from the diff between base and head.

Do not reuse `<slug>--deliver.md` for this record; that file is the Builder
execution report and review treats it specially. Then record the expectation:

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

## Verify

Run `review-work` and `verify-work` as for `builder.build` `verify`:

- The critique must come from a reviewer whose runtime identity differs from
  the assignment holder. Pass `<slug>--existing-change.md` and the reviewed
  changed files as `--artifact-ref` values.
- `tests-evidence` must be command-backed (`--command`) and observed in the
  clean worktree at the pinned head.
- This flow creates no `<slug>--plan-work.md` or `<slug>--deliver.md`. Where the
  `review-work` and `verify-work` examples cite those files, cite
  `<slug>--existing-change.md` instead; a reference to a missing file is
  refused.

## Defects And New Heads

Defects block the run. There is no in-run repair, no `execute` step, and no
`implementation_defect`, `plan_gap`, or `decision_gap` route back. Fix the
change through `builder.build`, or push a new commit and review it in a new
run. A new head needs a new run under a new provider Work Item. The run is
keyed by the Work Item and archiving keeps its canonical record, so restarting
the same Work Item resumes the old run. Resuming with a different
`--source-head` is refused, including for a completed run.

## Consumers And Gaps

- `flow-agents workflow publish-delivery` accepts a completed run; its
  checkpoint commit is the pinned head.
- `merge-change` refuses these runs: they have no `pr-open` or
  `merge-ready-ci` step and produce no publish-change result. Merge through the
  provider's own controls.
- That the reviewer is not the change's author on the provider (for example
  the GitHub pull request author) is `NOT_VERIFIED`. The runtime enforces only
  that the reviewer differs from the assignment holder.
- That `--source-head` is the change's actual head on the provider is
  `NOT_VERIFIED`; nothing compares it with the pull request. The provider URL,
  base, and head in `<slug>--existing-change.md` are written by the caller and
  are `NOT_VERIFIED`.
- `acceptance.json` is not anchored to a planning step in this flow.
