# PR body file-reference fixtures (#1375)

These `*.md` files are **verbatim** pull request bodies as GitHub stored them. They are
historical records, not synthesized inputs: `pr-1366-fabricated-body.md` is the body that
motivated `scripts/ci/validate-pr-body-file-refs.mjs`, and its claim about
`src/cli/trust-bundle-verifying-actor.test.mjs` — a file that lived on sibling branch
#1368 and appeared 0 times in #1366's own diff — is the failure the check has to red on.

Do not edit or regenerate them. A guard proven only against a synthetic happy path is
unproven; rewriting these to satisfy some other check would remove the only evidence that
this one catches the real incident. `evals/static/test_pr_body_file_refs.sh` owns them.

Each body has a `*.expected-paths.txt` answer key: the exact set of repo-rooted file
references the extractor must find in it, one per line, hand-checked against the body.
The suite asserts equality in both directions, so over-matching prose and under-matching a
real reference are both red.
