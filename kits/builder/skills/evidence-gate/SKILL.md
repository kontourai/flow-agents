---
name: "evidence-gate"
description: "Evaluate whether completed work is trustworthy enough for human review, merge, or release. Use after implementation, verify-work, provider checks, CI, or remediation to map acceptance criteria to evidence, inspect scope integrity, classify failures, assess check health, and produce a confidence report."
---

# Evidence Gate

Build confidence with falsifiable evidence, not process completion.

Evidence Gate is not Release Readiness. It asks whether completed work has enough trustworthy evidence, scope integrity, and provider/runtime signal to publish the change, continue fixing, or ask for a human decision. Release Readiness comes later and decides whether a published branch/provider change should merge, release, deploy, hold, or roll back.

## Contract

- Review evidence after implementation and verification.
- Do not fix code.
- Do not mark unverified work as passing.
- Treat `NOT_VERIFIED` as a first-class outcome.
- Separate evidence provenance: human-authored, agent-authored, CI-generated, runtime-observed.
- Do not approve release readiness.
- After a clean local evidence verdict, require a publish-change gate before `release-readiness`: verified diff committed, branch pushed, provider change opened or updated by the active `ChangeProvider` or an explicit no-provider-change reason recorded, closing refs recorded, provider checks known, and evidence refs linked.
- Provider-facing summaries, PR/change descriptions, issue comments, closure comments, and final acceptance comments that claim implementation behavior must include an `Acceptance Evidence` table with columns `AC id`, `Status`, `Command/Test Evidence`, `Source Evidence / Permalinks`, and `Gaps`.

## Inputs

- Work brief or selected GitHub issue.
- Execution plan.
- Verification report.
- Provider change / branch / check run links when available.
- Changed-file summary.
- Active TODOs, issue links, and release/rollback notes.
- Cross-repo dependency/provider coverage matrix when work spans multiple
  products, package-manager roots, generated artifact locations, install
  scripts, CI, or shared workflow guidance.

## Artifact Contract

Write or update `.kontourai/flow-agents/<slug>/<slug>--evidence-gate.md` with:

- `intent`: issue/brief, acceptance criteria, non-goals, risk class
- `evidence_manifest`: command/check name, source, timestamp, result, link/output pointer
- `test_map`: acceptance criterion to evidence tier and gaps
- `integrity_report`: scope drift, weakened tests/config, sensitive files
- `ci_report`: checks, reruns, flakes, failures, skipped checks
- `risk_assessment`: residual risks and required human review
- `verdict`: PASS, FAIL, or NOT_VERIFIED
- `next_step`: publish-change, release-readiness, verify-work, execute-plan, plan-work, CI remediation, or human decision

Also write or update structured sidecars:

- `state.json`: phase `evidence`, current status, and required next action
- `acceptance.json`: final criterion statuses and goal-fit status
- `evidence.json`: normalized checks, `standard_refs`, external evidence refs, not-verified gaps, and verdict
- `handoff.json`: next step and blockers when verdict is not a clean pass

Prefer `npm run workflow:sidecar --` for sidecar updates when available, then validate the artifact directory before reporting a clean pass.

## Workflow

### 1. Anchor To Intent

Restate:

- original problem
- acceptance criteria
- non-goals
- expected risk class
- authoritative artifacts

If acceptance criteria changed after implementation began, flag scope drift unless the decision is documented.

### 2. Build Test Map

For each acceptance criterion, map evidence to one of:

- existing automated test
- new or modified automated test
- browser/runtime check
- static analysis
- CI check
- manual/human verification
- `NOT_VERIFIED` with rationale

Block clean pass if high-risk criteria have only indirect evidence.
Every acceptance criterion must map to evidence or `NOT_VERIFIED`.
For implementation-behavior claims, each criterion must map to both command/test proof and structured source evidence refs. Source refs require `kind: "source"`, `file`, `line_start`, `line_end`, and `excerpt`; include immutable GitHub blob permalinks pinned to a commit SHA in `url` when a pushed commit/provider URL exists. Local file/line refs are acceptable only as pre-publish fallback evidence.

Use this table shape in evidence-gate summaries and provider/closure comments:

| AC id | Status | Command/Test Evidence | Source Evidence / Permalinks | Gaps |
| --- | --- | --- | --- | --- |

Rows must preserve the original AC ids. If source evidence is missing for a behavior claim, the row must say `NOT_VERIFIED` or name an accepted gap; do not issue a clean pass from prose-only claims.

### 3. Scope And Integrity Check

Check for process gaming or accidental drift:

- scope expanded beyond issue/brief
- acceptance criteria changed after implementation
- tests removed or weakened
- verification config altered
- CI config altered
- required CI bypassed
- sensitive files touched without review

Sensitive areas include auth, security middleware, data migrations, CI config, deployment scripts, feature flags, test helpers, lint/type config, payment, crypto, and filesystem/network operations.

For multi-repo or cross-product changes, require an explicit coverage matrix
before a clean pass. The matrix must list every affected product/repo root and
the status of build/test evidence, dependency/security review, provider/CI
evidence, and any accepted gaps. A clean evidence verdict requires every
applicable root to be covered or a human-accepted gap recorded with the reason.
Do not infer cross-product coverage from a passing subset.

### 4. CI And Flake Assessment

Use `github-cli` / `gh` when available.

Record:

- check names
- pass/fail/skipped
- rerun count
- flake suspicion
- logs or artifact links
- failure class
- standard evidence refs when CI emits SARIF, JUnit, TAP, OpenTelemetry, Veritas, or another native proof format

For Flow Agents source changes, prefer the GitHub Actions `Flow Agents CI / Builder Kit Baseline` provider check when present. Its local equivalent is `bash evals/ci/run-baseline.sh`, which writes `evals/results/ci-baseline/summary.md` and command logs. Treat skipped live GitHub mutation checks, LLM acceptance, or unavailable Veritas/governance evidence as explicit skip or `NOT_VERIFIED` entries based on the work's risk class; do not convert the baseline summary into proof that those live lanes ran.

Treat passed-after-rerun as degraded confidence unless explained.

### 5. Evidence Tiers

Classify evidence:

- Tier 0: claim only, no artifact.
- Tier 1: local command output.
- Tier 2: automated test tied to acceptance criterion.
- Tier 3: CI-confirmed test on a clean environment.
- Tier 4: runtime/browser/production-like verification with trace or log artifact.
- Tier 5: post-deploy telemetry confirms expected behavior.

Higher-risk work requires stronger tiers.

When an evidence source already has a standard format, keep that format as the native artifact and reference it from `evidence.json`:

- SARIF: static analysis, security, code review, and policy findings.
- OpenTelemetry logs/traces: runtime behavior, tool/model calls, workflow telemetry, and post-deploy events.
- JUnit/TAP: test results.
- Veritas: optional evidence checks, repo standards, and authority settings. Flow Agents records the Veritas reference and verdict but does not own Veritas policy semantics.

Use `context/contracts/governance-adapter-contract.md` before invoking Veritas or any similar governance provider. If the adapter is unavailable, record `NOT_VERIFIED` unless the user explicitly accepts skipping that governance evidence.

### 6. Verdict

Produce:

- `PASS`: evidence satisfies risk and acceptance criteria.
- `FAIL`: evidence shows the work is wrong or unsafe.
- `NOT_VERIFIED`: evidence is missing, indirect, blocked, or inconclusive.

For failures, classify:

- implementation defect
- bad plan
- bad acceptance criteria
- flaky infrastructure
- missing environment
- security concern
- product ambiguity
- scope drift

Include required next evidence and whether to return to `plan-work`, `execute-plan`, `verify-work`, `remediate-ci`, or human decision.

### 7. Publish Change Gate

If the evidence verdict is otherwise `PASS` but the verified diff is not committed, pushed, and represented by a provider change record or an explicit no-provider-change reason, set `next_step` to `publish-change` instead of `release-readiness`.

Use `git` and the active `ChangeProvider` adapter when available to:

- confirm the working tree contains only the verified scope
- commit the verified diff with a clear message
- push the branch
- open or update the provider change record linked to the issue/brief, closing refs, and evidence artifact, or record why no provider change is required
- include or update the provider-facing `Acceptance Evidence` table, upgrading local source refs to immutable GitHub blob permalinks when the commit SHA and repository URL are known
- collect provider check/CI links and statuses, or record why provider checks are unavailable
- keep GitHub PRs as the first `ChangeProvider` adapter example: for GitHub, open or update a PR and collect PR checks

If commit, push, provider change publication, or provider checks are blocked, keep the release path at `NOT_VERIFIED` or `HOLD` until the blocker is resolved or explicitly accepted by the user.

### 8. Dependency And External-Audit Coverage

When dependency review is in scope, evidence-gate must preserve both local
inventory evidence and external advisory/audit evidence separately. External
audit commands and registry/advisory lookups may disclose private dependency
metadata; if the execution policy rejects the command or the user has not
explicitly approved that disclosure, record the affected roots as
`NOT_VERIFIED` for external audit and name the privacy/approval blocker.

For cross-product work, a dependency/security lane can pass only when every
applicable package-manager root has one of these recorded outcomes: `pass`,
`fail`, `skip_no_manifest`, or an accepted `not_verified` gap. Existing
vulnerabilities are still `FAIL` for the dependency lane unless the user
explicitly accepts them as unrelated residual risk.

## Gate

Evidence passes only when acceptance criteria, scope integrity, CI/runtime evidence, and residual risk are sufficient for the risk class.

For an active Builder Flow run, record merge readiness only after this skill reaches `PASS`:

```bash
npm run workflow:sidecar -- record-gate-claim .kontourai/flow-agents/<slug> \
  --expectation merge-readiness \
  --status pass \
  --summary "Evidence gate passed: verified scope, acceptance evidence, review findings, and unresolved risks support provider review." \
  --evidence-ref-json '{"kind":"artifact","file":".kontourai/flow-agents/<slug>/evidence.json","summary":"Structured evidence verdict and acceptance coverage."}'
```

Record `fail` or `not_verified` when the verdict is not `PASS`. The resulting trust bundle is evaluated by Flow and may route back to verification, execution, planning, or Probe according to the canonical definition.

After `PASS`, hand off to `publish-change` when the work is still local, or to `release-readiness` when the verified commit, pushed branch, provider change record or no-provider-change reason, provider checks, closing refs, structured evidence refs, and `Acceptance Evidence` table are available. After `FAIL` or `NOT_VERIFIED`, stop and name the missing work or evidence.
