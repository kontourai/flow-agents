# Committed config adoption audit

This repository now supports the reviewable durable path
`.flow-agents/config/` while retaining ignored runtime/install state in `.flow-agents/`
and all `.kontourai/` state. This document is an audit record, not a downstream
mutation plan.

## What downstream repositories need

1. Converge `.gitignore` on ignoring `.flow-agents/*` while re-including only
   `.flow-agents/config/**`; keep `.kontourai/` ignored.
2. Add CODEOWNERS coverage for `.flow-agents/config/`, the core/Kit schemas,
   immutable loader, and every runtime consumer.
3. Add `core.config.json` only when a reviewed policy is desired. Absence
   preserves legacy defaults.
4. Use `flow-agents effective-flow-agents-config` to inspect immutable
   provenance, ignored drift, rejected production overrides, and proposal-only
   Kit previews before landing configuration.

No downstream repository was changed by this audit. Live adopt/defer routing is
[kontourai/ops#136](https://github.com/kontourai/ops/issues/136): it owns the
suite inventory and requires every source change to land through that
repository's own reviewed PR. Ignore and CODEOWNERS changes remain repository
authority, not package-install side effects.

## Read-only suite snapshot — 2026-08-01

The GitHub default branches of all 28 non-archived `kontourai` repositories were
queried read-only for `.flow-agents/config/core.config.json` and `.gitignore`.
No repository currently has a committed core configuration (including this
repository before this branch merges). Twenty-seven expose a `.gitignore` for a
mechanical ignore-boundary review; `personal-agents` has no root `.gitignore`.

`kontourai/ops#136` is the live route for the `ops` → `evals` → `veritas` →
`station` dogfood sequence and the remaining inventory. The required decision
is local: each owner chooses whether to keep defaults (no core file) or review
a stricter policy. This audit does not imply that Flow Agents may create files
in those repositories or that individual downstream changes have landed.
