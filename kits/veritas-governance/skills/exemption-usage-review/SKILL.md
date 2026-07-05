---
name: "exemption-usage-review"
description: "Periodic audit of standing delivery/DECLARED no-agent-delivery exemptions (ADR 0022 §3): lists every current exemption's scope, reason, approver, and age since declared_at, flags entries overdue for owner re-confirmation against a configurable staleness threshold, and walks the file's git history for a supplementary commit-level trail. Use when periodically reviewing which no-agent-delivery exemptions are still standing and whether any need re-confirmation."
---

# Exemption Usage Review

Read `delivery/DECLARED`, list every standing exemption with its age, and flag which ones
are overdue for owner re-confirmation — **process visibility, not enforcement** (ADR 0022
§3). This skill never changes `delivery/DECLARED` and never changes
`scripts/ci/trust-reconcile.js`'s reconciliation/exit-code behavior.

## Contract

- Read-only against `delivery/DECLARED` and its git history — no write, no mutation, no
  append, no delete, anywhere in this repo.
- Never gates anything: this is a **skill**, not a flow. It has no `expects[]` claim to
  evaluate and attaches no evidence. There is no pass/fail verdict — only a report.
- Never influences `scripts/ci/trust-reconcile.js`'s reconciliation decision or exit code.
  The reconciler is unaware this skill exists, exactly as it is unaware of the rest of this
  kit (ADR 0022 §3, "uninstalling `veritas-governance` must never weaken enforcement").
- Does not reimplement `scripts/ci/trust-reconcile.js`'s `matchesScope` /
  `matchesScopeCondition` / `parseDeclaredMarker` functions. The review lists **every**
  standing entry unconditionally — it has no "does this scope match the current change"
  question to answer (that is the reconciler's job, evaluated per-change at CI time). This
  skill answers a different question — "what exemptions exist at all, and how old are they" —
  so it needs only a much simpler parse-and-age routine, not the reconciler's scope-matching
  engine. See `review-exemptions.mjs`'s header comment for the same note in code.
- No `.kontourai/flow-agents/<slug>/` session artifact contract applies here: this skill
  produces a standalone report (stdout, human-readable or `--json`), not a workflow sidecar
  artifact. State this plainly rather than inventing an artifact contract this tool does not
  need.

## What this review does and does not verify

**Does verify:**
- Every entry currently present in the live `delivery/DECLARED` file is listed with its
  `scope`, `reason`, `approved_by`, `declared_at`, a computed `age_days` (now, or `--as-of`,
  minus `declared_at`), and a `stale` boolean (`age_days > --stale-days`, default 90).
- The `git log --follow -- delivery/DECLARED` commit history for the file — optionally
  bounded to a `--window-days` review window — is walked and reported as a supplementary
  commit-level trail (sha, author, date, subject).

**Does not verify:**
- Whether any `approved_by` value names a real, authenticated human approver.
  `approved_by` is free text on `delivery/DECLARED` itself (see this kit's own
  `docs/README.md`, "Human-approval evidence: what is and is not enforced") — this tool
  reports what the field says, it does not authenticate it.
- Whether any entry's `scope` (`ref:`/`commit:`/`author:`/`branch-prefix:`, or a
  compound-AND combination) currently matches any particular change. That is
  `scripts/ci/trust-reconcile.js`'s job at reconciliation time — a "does this exemption
  apply to THIS change" question this review never asks. This review lists every entry
  regardless of whether it currently matches anything.
- A full point-in-time reconstruction and diff of every historical version of
  `delivery/DECLARED` (e.g. "entry X was removed then silently re-added with a different
  reason"). `history_commits` gives the commit-level trail a human reviewer can inspect
  further with `git show <sha>:delivery/DECLARED`; this tool does not do that per-commit
  content diffing itself.
- Anything about whether the exemption is still *needed* — that is an owner judgment call
  this review surfaces evidence for, not a decision it makes.

## Inputs

- `delivery/DECLARED` (default; override via `--declared-path <path>` for a fixture or a
  different repo layout).
- `--repo-root <path>` (default: current working directory) — the git repository whose
  history is walked.
- `--stale-days <n>` (default: `90`) — the configurable age threshold. Entries with
  `age_days > stale-days` are flagged `stale: true`.
- `--window-days <n>` (optional; default: full history) — bounds the `git log --follow`
  history walk to commits within the last `<n>` days of `--as-of`. Does not affect which
  *current* entries are listed — the live file's entries are always listed in full; this
  only bounds the supplementary history trail.
- `--as-of <ISO8601>` (default: `new Date().toISOString()`, i.e. wall-clock now) —
  deterministic override for "now", so a scheduled/periodic invocation or an eval is not
  wall-clock-flaky. Mirrors this repo's `TRUST_RECONCILE_SHA`/`_REF`/`_ACTOR` override
  convention in `scripts/ci/trust-reconcile.js`.
- `--json` (optional) — emit a machine-readable JSON report instead of the human-readable
  table.

## How to run the review

```bash
# Human-readable report against this repo's real delivery/DECLARED, default 90-day threshold.
node kits/veritas-governance/skills/exemption-usage-review/review-exemptions.mjs

# Machine-readable, with an explicit deterministic "now" and a tighter threshold.
node kits/veritas-governance/skills/exemption-usage-review/review-exemptions.mjs \
  --as-of 2026-07-05T00:00:00Z --stale-days 30 --json

# Bound the supplementary history walk to the last 180 days.
node kits/veritas-governance/skills/exemption-usage-review/review-exemptions.mjs \
  --window-days 180
```

Exit code: `0` on a clean run — even when one or more entries are flagged `stale`. Staleness
is informational output for a human owner to act on, never a script failure condition. Exit
`2` on bad arguments; exit `3` when `delivery/DECLARED` is missing or not valid JSON (nothing
to review — a tool-usage failure, not a staleness finding).

## Output shape

Each standing-exemption row: `{scope, reason, approved_by, declared_at, age_days, stale}`.
`age_days`/`stale` are `null` (never silently coerced to `true`/`false`) when `declared_at`
is missing or unparsable — an honest "unknown", not a guessed verdict.

The history section separately reports `{sha, author, date, subject}` per commit found by
`git log --follow -- delivery/DECLARED` in the (optionally windowed) range. A git failure
(no repository, no history, shallow clone) degrades to an empty history list plus a
diagnostic note — never a crash and never a fabricated commit.

## What happens with a stale entry

A `stale: true` entry means: this exemption has been standing longer than the configured
threshold without a recorded re-confirmation. This review does not renew, revoke, or modify
the entry itself — it surfaces the finding for an owner to act on: re-confirm the exemption
is still needed (e.g. re-run the kit's exemption-issuance flow to record a fresh
`declared_at` with the same or updated `reason`/`approved_by`), or remove it from
`delivery/DECLARED` by direct, CODEOWNERS-reviewed edit. Both of those actions are outside
this skill's scope by design — this skill only reports.

## Accepted gap: nothing schedules this review

ADR 0022 §3 asks for the review tool to exist, not for automated scheduling. This skill has
no CI job, cron trigger, or scheduled invocation wired to it — an operator must run it
periodically themselves (see "How to run the review" above). This is an accepted,
explicitly-named scope boundary, not a silent gap: building a scheduling/CI-trigger surface
was not requested and is not part of this slice.
