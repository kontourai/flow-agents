# Developer Git Hook Setup

Flow Agents has a repo-owned Git pre-push lane for contributors who want local checks before pushing this repository.

Enable it per clone:

```bash
npm run setup:repo-hooks
```

That command is idempotent and only writes repo-local Git config:

```bash
git config --local core.hooksPath .githooks
```

Verify the setting:

```bash
git config --local --get core.hooksPath
```

The expected value is `.githooks`.

## Pre-Push Lane

The tracked `.githooks/pre-push` hook runs bounded local checks:

```bash
npm run validate:repo-hooks --silent
npm run validate:source --silent
```

These checks do not perform network access. They validate the repo hook setup and the source tree from the repository root. Use normal Git bypass mechanics, such as `git push --no-verify`, only when you have a reason to skip local developer checks.

## Product Boundary

This Git hook lane is developer workstation safety tooling for the Flow Agents repository. It is not a Flow Agents runtime hook and does not participate in runtime adapter activation, hook influence tiers, Flow Definition gate semantics, trusted producer config, or exported agent hook configuration.

Runtime hooks remain under `scripts/hooks/` and are evaluated through the runtime hook docs and hook-influence checks. The repo Git hook only runs local package checks before a push; it must not change runtime hook behavior.
