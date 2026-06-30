---
name: "release-readiness"
description: "Decide whether evidence-backed work is ready to merge, release, deploy, or hold. Use after evidence-gate PASS, before merge/release/deploy, and for post-deploy verification planning."
---

# Release Readiness

Turn a clean evidence result into an explicit release, deploy, or hold decision.

Release Readiness is not Evidence Gate. Evidence Gate decides whether completed work is trustworthy enough to publish or continue fixing. Release Readiness assumes evidence is clean and then checks the real publish/release surface: committed diff, pushed branch, provider change record or explicit no-provider-change reason, provider checks, ownership, rollout timing, rollback, observability, docs, and post-deploy verification.

## Contract

- Use only after `evidence-gate` has produced `PASS`, or explicitly record why release review is blocked.
- Use only after the verified changes have been committed, pushed, and represented by a provider change record or an explicit no-provider-change decision.
- Do not fix code or weaken release criteria.
- Do not deploy unless the user explicitly asks and the environment is clear.
- Treat merge, release, deploy, and post-deploy verification as separate gates.
- Record rollback, observability, and ownership before approving release.
- Treat final acceptance documentation as part of release readiness: CI/merge should leave durable docs or an explicit reason they are not needed.

## Inputs

- Evidence gate artifact and verdict.
- Issue/brief, commit SHA, pushed branch, provider change link or no-provider-change reason, provider check run links, and changed-file summary.
- Release notes, migration notes, feature flags, deploy target, and rollback plan.
- Known incidents, freezes, dependency risk, and owner availability.

## Artifact Contract

Create or update `.kontourai/flow-agents/<slug>/<slug>--release-readiness.md` with:

- `release_scope`: work included, excluded, issue/provider-change links
- `evidence_reference`: evidence artifact, verdict, residual risks
- `risk_review`: migrations, data, security, dependencies, flags, compatibility
- `operational_plan`: deploy target, order, owner, timing, comms
- `rollback_plan`: trigger, steps, owner, expected recovery signal
- `observability_plan`: metrics, logs, traces, alerts, dashboards
- `post_deploy_checks`: checks, commands, URLs, timing, expected signals
- `final_acceptance_docs`: long-lived docs updated, archived `.kontourai/flow-agents/<slug>/` links, and deferred docs follow-ups
- `decision`: MERGE, RELEASE, DEPLOY, HOLD, or ROLLBACK_REQUIRED

When the repository provides `npm run workflow:sidecar --`, also write `release.json` with:

```bash
npm run workflow:sidecar -- record-release .kontourai/flow-agents/<slug> \
  --decision merge \
  --scope "..." \
  --evidence-ref evidence.json \
  --gate-json '{"name":"merge","status":"pass","summary":"..."}' \
  --rollback-json '{"status":"not_required","summary":"...","owner":"..."}' \
  --observability-json '{"status":"not_required","summary":"..."}' \
  --docs-json '{"status":"updated","summary":"..."}' \
  --summary "..."
```

Use additional `--gate-json` and `--post-deploy-json` values for release, deploy, docs, and post-deploy gates as needed.

After writing `release.json`, run artifact validation when available. If `record-release` is unavailable or blocked, keep the release decision as `HOLD` in the Markdown artifact and record the sidecar-write or validation blocker as a `NOT_VERIFIED` evidence gap until the structured release record can be written or the gap is explicitly accepted.

## Workflow

### 1. Confirm Evidence

Verify the evidence verdict is `PASS`, current, and tied to the release scope. If scope changed, return to `evidence-gate`.

Then verify the publish-change gate:

- verified diff is committed
- branch is pushed
- provider change record is open or updated, or a no-provider-change reason is explicitly recorded
- provider checks / CI are linked and their status is known
- GitHub PRs remain the first `ChangeProvider` adapter example: for GitHub, the provider change record is the PR and provider checks include PR checks

If these are missing, return `HOLD` and route back to `publish-change` or `evidence-gate`; do not make a merge/release/deploy decision from local verification alone. Missing provider checks also return `HOLD` unless the risk class supports accepting the gap and the no-check reason is recorded.

For Flow Agents source changes, the default provider check is the GitHub Actions `Flow Agents CI / Builder Kit Baseline` job. Its summary should list command results, artifact names, and skipped live lanes. A passing baseline supports merge readiness for deterministic workflow, docs, hook, package, and bundle checks, but it does not prove live GitHub mutation, LLM acceptance, or Veritas/governance provider evidence unless those lanes are explicitly run and linked.

### 2. Review Release Risk

Check migrations, feature flags, config, dependency changes, compatibility, security-sensitive paths, customer impact, and deploy timing.

### 3. Plan Operation

Record who owns merge/release/deploy, where it happens, when it happens, what communication is required, and what must not be included.

### 4. Plan Rollback

Define rollback trigger, rollback steps, owner, data recovery limits, and the signal that confirms recovery.

### 5. Plan Post-Deploy Verification

Map expected behavior to production-like checks, telemetry, dashboards, logs, smoke tests, or manual verification. High-risk work must have direct runtime evidence planned.

### 6. Decide

Produce one verdict:

- `MERGE`: safe to merge, release/deploy not yet authorized.
- `RELEASE`: safe to cut or publish a release artifact.
- `DEPLOY`: safe to deploy with recorded owner and checks.
- `HOLD`: blocked by risk, timing, missing evidence, or ownership.
- `ROLLBACK_REQUIRED`: deployed state is unsafe and rollback should be considered.

### 7. Promote Delivery Knowledge

When CI has passed and merge/release acceptance is clear, require a docs decision:

- update long-lived docs with what changed, how to use it, and important why/how decisions; or
- record why no durable docs are needed; and
- link back to the archived `.kontourai/flow-agents/<slug>/` plan/session artifact for implementation history.

## Gates

- Merge Gate: evidence is current, scope matches, CI is acceptable, and review ownership is clear.
- Release Gate: versioning, notes, compatibility, and artifact risk are clear.
- Deploy Gate: deploy owner, target, rollback, and observability are ready.
- Post-Deploy Gate: checks are scheduled or completed and signals are recorded.
- Docs Gate: durable docs are updated, intentionally skipped, or routed to an owned follow-up.

After deployment evidence exists, hand off to `learning-review` to capture outcomes.
