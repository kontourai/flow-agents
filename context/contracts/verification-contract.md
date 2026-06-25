# Verification Contract

Verification is report-only. It proves whether the implementation satisfies the plan, the Definition Of Done, and the original user outcome.

## Required Inputs

- session artifact path when available
- plan artifact path or acceptance criteria
- Definition Of Done and stop-short risks
- modified files
- build, test, lint, browser, or runtime commands from the plan, AGENTS.md, or project conventions

## Report-Only Rule

Verifiers and reviewers do not modify source code. They may run commands, inspect files, take screenshots, and write verification artifacts. They must not apply fixes, formatting, lint autofixes, or patches.

## Verification Phases

Attempt relevant phases and record evidence:

- Build: compile or bundle the project
- Types: run detected static type checks
- Lint: run detected lint or quality checks
- Tests: run affected or full tests, with coverage when available
- Security: scan for secrets, debug artifacts, and dependency issues when relevant
- Diff review: inspect changed files against acceptance criteria
- Browser or visual checks: use screenshots, accessibility checks, and interaction tests for UI changes
- Provider checks: collect CI, status, review, mergeability, deployment, policy, or equivalent ChangeProvider evidence after publish-change when release confidence depends on the provider

If a tool or environment is unavailable, mark that phase `NOT_VERIFIED` with the reason. Do not skip silently.

A flaky or intermittently-failing test is a real defect — a race, a fail-open, or nondeterminism — not noise. Root-cause it; never re-run to green or mark it `skip`/`pass` to move on. An operation that can pass without doing its job is a failure, not a flake.

Provider-check gaps are risk-based:

- Docs-only changes may use `SKIP` / `skip` for missing provider checks only when the report names the skipped check, explains why local docs evidence is enough, and the repository does not require the missing check.
- Runtime, schema, package, hook, security, migration, release, infrastructure, or deployment changes require provider check evidence or equivalent proof. If that proof is missing, mark the provider check and any affected acceptance/release item `NOT_VERIFIED`; release-readiness must hold rather than treating the gap as pass.
- Provider API failure, unknown mergeability, missing required review, or absent CI is not a clean pass for risky changes.

## Verdicts

- `PASS`: all required criteria are satisfied with evidence, and no required phase failed or remains unaccepted.
- `FAIL`: at least one acceptance criterion, required check, or Goal Fit item failed.
- `NOT_VERIFIED`: required evidence could not be collected.
- `PARTIAL`: only for legacy reports where some criteria pass and some fail or remain unverified; route it like a non-pass.

## Required Report Shape

```markdown
## Verification Report

Build:     [PASS/FAIL/NOT_VERIFIED/SKIP] <command, exit code, or reason>
Types:     [PASS/FAIL/NOT_VERIFIED/SKIP] <command, result, or reason>
Lint:      [PASS/FAIL/NOT_VERIFIED/SKIP] <command, result, or reason>
Tests:     [PASS/FAIL/NOT_VERIFIED/SKIP] <command, result, coverage, or reason>
Security:  [PASS/FAIL/NOT_VERIFIED/SKIP] <findings or reason>
Provider:  [PASS/FAIL/NOT_VERIFIED/SKIP] <provider checks, change ref, or risk-based skip reason>
Diff:      [PASS/FAIL/NOT_VERIFIED] <changed files reviewed>

### Acceptance Criteria
- [PASS/FAIL/NOT_VERIFIED] <criterion> - <evidence or gap>

### Goal Fit
- [PASS/FAIL/NOT_VERIFIED] User outcome - <evidence or gap>
- [PASS/FAIL/NOT_VERIFIED] User-facing workflow - <docs, commands, UI, screenshots, or gap>
- [PASS/FAIL/NOT_VERIFIED] Durable docs target - <updated, deferred, not needed, or gap>
- [PASS/FAIL/NOT_VERIFIED] Stop-short risks - <resolved, accepted, or still open>

### Verdict: PASS | PARTIAL | FAIL | NOT_VERIFIED
<summary>
```

## Structured Evidence Sidecar

When verification runs as part of a workflow, write or update `evidence.json` beside the workflow artifacts using `schemas/workflow-evidence.schema.json`.

Use the sidecar writer when available:

```bash
npm run workflow:sidecar -- record-evidence .flow-agents/<slug> \
  --verdict pass \
  --check-json '{"id":"tests","kind":"test","status":"pass","summary":"Relevant checks passed."}'
```

Map phases to check kinds:

- Build -> `build`
- Types -> `types`
- Lint -> `lint`
- Tests -> `test`
- Security -> `security`
- Diff -> `diff`
- Browser or visual checks -> `browser`
- Runtime checks -> `runtime`
- External policy or governance checks -> `policy` or `external`
- Provider checks from publish-change or release surfaces -> `external`

Use lowercase statuses: `pass`, `fail`, `not_verified`, or `skip`. Set the top-level `verdict` to `pass`, `partial`, `fail`, or `not_verified`. Include `not_verified_gaps` for any missing required evidence.

Modified files are part of verification scope. If changed-file scope is unavailable, mark diff/scope integrity `NOT_VERIFIED` instead of inferring from memory. Optional governance providers such as Veritas may use the same modified-file scope as input or as an integrity reference, but their native reports should remain external evidence referenced from `evidence.json`.

When evidence has a native standard artifact, include `standard_refs` on the relevant check instead of flattening that artifact into prose:

- SARIF for static analysis, code review, security, and policy findings
- OpenTelemetry logs or traces for runtime, tool, model, workflow, and production-like event evidence
- JUnit or TAP for test runner output
- Veritas for optional policy/proof-lane evidence owned by Veritas

Use `external_evidence` for evidence stored outside the artifact directory, with `system`, `ref`, optional `summary`, and optional `standard`.

External governance evidence follows `context/contracts/governance-adapter-contract.md`. Veritas is optional: when present, reference its native artifact with `standard: "veritas"`; when absent, do not invent a pass.

Published change evidence follows `context/contracts/work-item-contract.md`. Record ChangeProvider evidence as provider-neutral refs: `work_item_ref`, `board_ref`, `change_ref`, provider checks, closing-reference checks, and evidence refs. GitHub pull requests are the first adapter example, not required core terminology.

Update `acceptance.json` when acceptance criteria move from `pending` to `pass`, `fail`, `not_verified`, or `accepted_gap`.

## Final-State Reconciliation

Verifier-local mismatch notes are pre-orchestration observations. They are useful for catching stale Markdown or sidecars, but they are not the terminal source of truth after the orchestrator updates final sidecars.

Before a clean terminal verdict:

- read the final `acceptance.json`, `evidence.json`, and `release.json` when present
- ensure Markdown summaries and sidecars no longer silently contradict each other
- record final sidecar validation evidence or mark the mismatch `NOT_VERIFIED`
- supersede earlier mismatch notes only by naming the final reconciled sidecars and evidence

If final sidecars still disagree with the Markdown artifact, return `NOT_VERIFIED` or `FAIL` according to the affected acceptance criteria.

## Verdict Rules

- Every acceptance criterion gets a status.
- Evidence is mandatory for PASS.
- `NOT_VERIFIED` is honest uncertainty, not failure disguised as success.
- A technically green build is not enough for PASS when the user still cannot run, inspect, understand, or act on the result.
- The orchestrator routes FAIL, PARTIAL, and unaccepted NOT_VERIFIED back through execution or to an explicit user decision.
