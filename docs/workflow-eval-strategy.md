---
title: Workflow Eval Strategy
---

# Workflow Eval Strategy

The Builder Kit workflow system now has concrete skill contracts for `idea-to-backlog`, `pull-work`, `plan-work`, `review-work`, `deliver`, `evidence-gate`, `release-readiness`, and `learning-review`, plus shared workflow contracts in `context/contracts/`. Evals should prove both the written contracts and the agent behavior around gates, artifacts, worktrees, Goal Fit, release readiness, final acceptance docs, and learning feedback.

Flow Agents evals prove coordination, install, runtime adapter behavior, and artifact discipline. They should not redefine Flow gate authority: Flow Definitions use typed `expects` entries, Surface claim gates use `kind: "surface.claim"`, and Flow project config owns trusted producer mappings plus gate overrides.

## Goals

Prove that workflow skills are operational, not just descriptive:

- Agents activate the right workflow for the right user intent.
- Upstream shaping does not collapse into implementation.
- Provider-backed work items are treated as executable backlog, not the whole reasoning store; GitHub issues are the first adapter example.
- Provider-neutral work item, board, change, check, and evidence terms remain the core vocabulary; GitHub stays an adapter/example.
- Work selection considers readiness, WIP, blockers, Probe needs, and worktree isolation.
- Review is report-only critique and records findings separately from verification evidence.
- Evidence review is report-only and maps claims to falsifiable proof.
- Goal Fit catches task-complete-but-user-incomplete delivery before final response.
- Release readiness, final acceptance docs, and learning review are covered before work is treated as done.
- Failures produce actionable feedback into skills, evals, tests, backlog, or knowledge.

## Eval Layers

### 1. Static Contract Evals

Run on every static pass.

File: `evals/static/test_workflow_skills.sh`

These check that skill contracts preserve non-negotiable guardrails:

- `idea-to-backlog` forbids production implementation and keeps upstream work separate from `plan-work`, `execute-plan`, `review-work`, and `verify-work`.
- `pull-work` forbids implementation, enforces WIP awareness, records worktree decisions, returns vague work to shaping, and hands off to `plan-work`.
- `plan-work` requires `Definition Of Done`, stop-short risks, and durable docs target.
- `deliver` requires `Goal Fit Gate` and `Final Acceptance` before local delivery is treated as complete.
- workflow skills and tool agents reference shared `context/contracts/` files instead of redefining artifact, planning, execution, review, verification, and delivery protocols independently.
- `review-work` separates critique from verification, delegates to `tool-code-reviewer`, conditionally delegates to `tool-security-reviewer`, and records findings in `critique.json`.
- `evidence-gate` is report-only, treats `NOT_VERIFIED` as first-class, includes scope/integrity checks, evidence tiers, and CI health, and remains separate from release readiness.
- `publish-change` is required between clean evidence and release readiness: verified diff committed, branch pushed, provider change opened or updated, and provider checks linked.
- `publish-change` records provider-neutral `PublishChangeResult` evidence: work item refs, board refs, change refs, closing-reference recognition, provider checks, and evidence refs.
- missing provider checks are risk-based: docs-only changes may pass with explicit skip, while runtime/schema/package/hook/security changes become `NOT_VERIFIED` or release `HOLD` without CI or equivalent provider evidence.
- `release-readiness` separates merge/release/deploy gates, rollback, observability, ownership, final acceptance docs, and post-deploy verification planning.
- final terminal delivery reconciles temporary verifier-local sidecar mismatch notes against authoritative final sidecars and orchestrator evidence.
- `learning-review` records observed facts, decisions, docs promotion state, gaps, follow-ups, knowledge updates, and avoids automatic policy mutation. Terminal learning evals must cover intended-vs-observed correction decisions: clean runs with `correction.needed: false` and no open route, and mismatches with `correction.needed: true`, typed correction type, stable recurrence key, gap, and prevention route or no-change rationale.

Static evals prove documented contracts did not drift. They do not prove the agent follows them in conversation.

Activation-only behavioral evals may assert no write tools when the goal is trigger and boundary testing. Artifact-quality evals must allow controlled writes to `.flow-agents/<slug>/*.md` and inspect the resulting artifact contracts.

### 2. Behavioral Activation Evals

Run when evaluating workflow behavior for Codex/Kiro changes.

File: `evals/cases/dev/promptfooconfig.yaml`

Core cases:

- `idea-to-backlog`: user asks to turn an idea into backlog but not code.
- `pull-work`: user asks to pick the next provider-backed work item without implementing.
- `evidence-gate`: user asks whether locally verified work is trustworthy enough to merge.
- Review work: user asks for quality/security/architecture critique after implementation.
- Release readiness: user asks whether a published change is ready to merge, release, deploy, hold, or roll back after evidence is clean.
- Learning review: user asks what should be captured after failures or prototype work.

These should verify:

- correct skill activation
- no premature implementation
- correct phase boundaries
- durable artifact intent
- appropriate use of `gh` / CLI where relevant
- explicit stop at gates
- clear `PASS`, `FAIL`, or `NOT_VERIFIED` outcomes where evidence is being assessed
- contract persistence after long, noisy, or stale context

### 3. Artifact Quality Evals

Inspect generated `.flow-agents/<slug>/*.md` files and provider-backed work item drafts for required structure.

The local artifact-quality gate is:

```bash
bash evals/integration/test_workflow_artifacts.sh
```

It exercises a realistic plan -> review -> delivery artifact chain and negative fixtures for missing Goal Fit, green-build-only delivery, and hidden `NOT_VERIFIED`.

Candidate assertions:

- `idea-to-backlog` artifact includes source ideas, current phase, triage decision, shaped work brief, readable story/outcome, stable `R*` requirement ids, stable `AC*` acceptance ids, priority rationale, milestone/delivery outcome, backlog gate, and work item links.
- `pull-work` artifact includes selected work item, readiness classification, WIP notes, blockers, Probe/design notes when needed, worktree decision, allowed scope, done criteria, and `plan-work` handoff.
- `pull-work` / pickup Probe artifacts include planned base ref/SHA when available, current target SHA, drift classification, and alignment routing for material scope, dependency, contract, or conflict drift.
- `plan-work` / `deliver` artifacts include Definition Of Done, requirement-to-acceptance trace, task-to-acceptance mapping, acceptance evidence expectations, stop-short risks, Goal Fit Gate, Final Acceptance, and durable docs target.
- `review-work` artifacts and `critique.json` include reviewer ids, verdicts, severity-tagged findings, artifact refs, and resolution state.
- `evidence-gate` artifact includes acceptance criteria map, evidence manifest, CI summary, scope/integrity report, `PASS` / `FAIL` / `NOT_VERIFIED`, and next step.
- `publish-change` artifact includes provider, work item refs, board refs, change ref, closing-reference check, provider checks, evidence refs, and next action.
- `release-readiness` artifact includes release scope, evidence reference, risk review, operational plan, rollback plan, observability plan, final acceptance docs, post-deploy checks, and decision.
- `learning-review` artifact includes outcomes, evidence, decisions, docs promotion state, gaps, follow-ups, knowledge updates, and verdict.
- Work item drafts include story/outcome, problem, scope, non-goals, stable `R*` requirement ids, stable `AC*` acceptance ids, source artifact links, priority rationale, milestone/delivery outcome, dependencies, and verification expectation.

### 4. Adversarial Workflow Evals

These cases check that the gates resist pressure and ambiguity:

- User asks to "just start coding" during `idea-to-backlog`; agent should hold the gate or require explicit continuation into delivery.
- Work item is vague; `pull-work` should return it to shaping instead of planning execution.
- Work item was planned against an older main SHA and relevant contracts changed; pickup Probe should classify `contract_drift` and route to alignment before planning.
- WIP is congested in review/verification; `pull-work` should prefer finishing active work before starting new implementation.
- Verification passed locally but CI is missing; `evidence-gate` should return `NOT_VERIFIED` or degraded confidence depending on risk.
- Docs-only change with missing provider checks and explicit skip rationale may pass when local docs evidence satisfies the risk.
- Runtime/schema/package/hook/security change with missing provider checks should return `NOT_VERIFIED` in evidence-gate or `HOLD` in release-readiness unless equivalent evidence is recorded.
- Tests were deleted or weakened; `evidence-gate` should flag integrity risk.
- CI passes only after unexplained reruns; `evidence-gate` should degrade confidence.
- Prototype code exists; workflow should require learning review before production promotion.
- Release notes, rollback, or observability are missing for production-impacting work; `release-readiness` should return `HOLD`, optionally routing missing evidence back to `evidence-gate`.
- Agent tries to stop with an active `.flow-agents/<slug>/` delivery artifact; `stop-goal-fit` should warn and strict mode should block.
- CI/merge acceptance happens but docs are not promoted; release readiness or learning review should record a docs follow-up or explain why durable docs are not needed.
- Temporary verifier-local sidecar mismatch notes remain in the history; terminal artifacts must show final sidecar reconciliation before reporting clean delivery.
- Deep-context delivery contains stale shortcuts; agent should ignore stale context and still preserve Definition Of Done, explicit `NOT_VERIFIED`, Goal Fit, and Final Acceptance.

### 5. End-To-End Loop Evals

Run selectively for workflow release candidates.

```text
idea-to-backlog -> pull-work -> design-probe -> plan-work -> execute-plan -> review-work -> verify-work -> goal-fit -> evidence-gate -> publish-change -> release-readiness -> final-acceptance-docs -> learning-review
```

The end-to-end eval should assert that:

- each phase consumes the prior artifact instead of reinterpreting the goal from scratch
- worktree decisions are recorded before implementation planning
- acceptance criteria survive through planning, implementation, review, verification, and evidence review
- requirement and acceptance ids survive from backlog work item through planning, implementation, review, verification, and evidence review
- Goal Fit checks the original user outcome before delivery
- shared contracts remain the source of truth even after context gets long
- failed or missing evidence loops back to the right phase
- release readiness, docs promotion, and learning feedback are produced before final completion

This layer is intentionally expensive and should not run on every edit.

The deterministic local smoke layer is cheaper than a full LLM end-to-end eval. It validates the persisted artifact chain with `npm run workflow:validate-artifacts --` and runs as part of `bash evals/run.sh integration`. Full LLM end-to-end evals should still be run for release candidates and model/profile changes.

The default Flow Agents CI baseline is the provider-check lane for ordinary pull requests and `main` pushes:

```bash
bash evals/ci/run-baseline.sh
```

It runs deterministic credential-free checks: source tree validation, context-map drift, static evals, workflow artifact checks, publish-change helper coverage, sidecar writer coverage, Goal Fit and workflow steering hooks, hook-influence contract checks, Flow Kit repository checks, runtime adapter activation, and bundle install smoke tests. It writes logs plus Markdown provider evidence summaries under `evals/results/ci-baseline/`. GitHub Actions uploads separate per-lane artifacts: `flow-agents-ci-source-and-static`, `flow-agents-ci-workflow-contracts`, and `flow-agents-ci-runtime-and-kit`.

Default CI intentionally skips live GitHub mutation checks, LLM behavioral/acceptance evals, and Veritas/governance provider evidence unless a maintainer opts into those lanes. The CI summary must name those skips so evidence-gate and release-readiness can classify them as accepted skips or `NOT_VERIFIED` according to change risk.

Surface trust artifact attachment is covered by deterministic schema, runtime, and report checks, not by live provider authority. The targeted local command is:

```bash
bash evals/integration/test_workflow_sidecar_writer.sh
```

That eval exercises Builder Kit `surface.claim` evidence using provider-neutral TrustReport / Trust Snapshot fixtures for accepted, rejected, stale, missing-authority, integrity-mismatch, provider-absent, and artifact-absent cases. It proves Flow Agents can record compact Surface claim evidence in `evidence.json` and report pass, fail, or `NOT_VERIFIED` gaps without requiring provider-specific fields.

This coverage does not redefine Flow gate authority. Flow Definitions continue to express expectations, Flow project config owns trusted producer mappings and gate overrides, and Flow gate authority remains outside the local report writer. Runtime/provider gaps should be recorded as `NOT_VERIFIED` when a configured Surface claim path cannot be checked; ordinary Builder Kit workflows remain valid when no trust provider or trust artifact is configured.

The same sidecar writer eval covers runtime transition enforcement without making Flow Agents the owner of transition semantics. It verifies that `record-evidence`, `advance-state`, `record-release`, `record-learning`, and `dogfood-pass` use the sidecar transition guard for `state.json` and `handoff.json` writes; verifier/evidence helpers cannot jump directly to terminal workflow state while release or learning gates remain; rejected transitions append `transition-diagnostics.jsonl` without mutating authoritative state or handoff sidecars; Builder Kit `builder.build` route-backs require declared reasons and respect deterministic max-attempt accounting; and legacy direct primitive workflows remain compatible when no Builder Kit Flow Definition context is present.

Learning sidecar evals also protect the correction contract. Positive fixtures validate a no-correction clean run and a correction-needed mismatch. Negative fixtures reject correction-needed records that omit `correction.recurrence_key` or omit both prevention route and `no_change_rationale`. These fields are local `learning.json` data for future metrics such as correction rate, resolved corrections, repeated recurrence keys, stale unresolved corrections, and clean-run rate; the evals must not require Console/dashboard UI, Source/Sink storage, provider issue automation, or a reconciliation CLI.

## Feedback Loop

Every failed behavioral or artifact eval should be classified:

- bad skill trigger description
- unclear workflow instructions
- missing artifact schema
- missing tool/subagent support
- bad eval prompt
- bad assertion/rubric
- model limitation
- real product ambiguity
- workflow design drift

Then update one of:

- skill frontmatter
- skill body
- static contract eval
- behavioral prompt/rubric
- artifact schema
- source workflow document
- backlog issue for missing tool support
- knowledge note for durable learning

Do not fix eval failures by weakening the goal. If the goal is wrong, update the design artifact first, then the eval.

Post-run usage feedback should be recorded through the normalized feedback-loop schema described in https://github.com/kontourai/flow-agents/blob/main/docs/agent-usage-feedback-loop.md. Behavioral evals that compare runtimes, repositories, profiles, prompts, judges, or skills should record outcome rows with stable `runtime`, `repo`, `profile_id`, `prompt_id`, `prompt_variant`, `skill_ids`, and `skill_variant` identifiers. This lets reports compare success rate, partial/failure/not-verified rate, duration, tool invocations, delegations, permission requests, rework rate, quality score, and human minutes saved across setups.

Quality outcomes are manual or eval-recorded evidence. Telemetry can count runtime behavior, but it should not automatically infer `quality_score`, `result`, rework, or saved time.

Example cross-repo comparison:

```bash
npm run usage-feedback -- report \
  --telemetry-dir ../repo-a/.telemetry \
  --telemetry-dir ../repo-b/.telemetry \
  --group-by repo
```

Example runtime and judge comparison:

```bash
bash evals/run.sh llm dev --runtime claude --judge-runtime codex --suite regression
bash evals/run.sh llm dev --runtime claude --judge-runtime claude --suite regression
bash evals/run.sh llm dev --runtime codex --judge-runtime claude --suite regression
```

Claude Code acceptance is cheap by default and should stay that way for routine checks. Use explicit opt-in flags only when spending Claude usage is intentional:

```bash
FLOW_AGENTS_ACCEPTANCE_CLAUDE_LLM=1 bash evals/run.sh acceptance claude
FLOW_AGENTS_ACCEPTANCE_CLAUDE_LLM=1 FLOW_AGENTS_ACCEPTANCE_REQUIRE_CLAUDE_TELEMETRY=1 bash evals/run.sh acceptance claude
```

Runtime hook behavior is intentionally tested at different levels. Keep these lanes separate when citing evidence for the Builder Kit `plan -> execute -> review -> verify` loop:

- Adapter evals prove runtime-specific adapters can transform hook output into the protocol shape expected by Codex, Claude Code, or Kiro. They prove delivery shape, not live model influence.
- Installed-command evals execute Claude Code, Codex, and Kiro hook commands from installed bundle paths against the same workflow state fixture. They prove the exported bundle can run and emit guidance from installed commands, not that a live model used that guidance.
- Claude Code live acceptance proves prompt-submit workflow-steering context reaches the model and changes the final response.
- Kiro live acceptance proves strict Goal Fit Stop gates surface as hook failures in the CLI. Kiro does not currently inject prompt-submit workflow-steering output back into model context in the live harness.
- Codex `exec` live acceptance proves exported agents and skill routing from a full installed bundle. Codex hook adapters and installed-command evals prove hook protocol output, but the current `codex exec` harness does not observe project hook guidance as model context. Record Codex live hook influence as `NOT_VERIFIED` / `documented-runtime-gap` unless a future live harness demonstrates that project hook guidance reached model context and changed the response.

Hook-influence behavioral cases live in `evals/fixtures/hook-influence/cases.json` and are validated by `npm run validate:hook-influence --`. These cases make the expected behavior explicit: what hook guidance must contain, what the agent must do after seeing it, and which evidence tier proves it. For `kontourai/flow-agents#62`, the required cases cover missing pickup Probe before planning, review-before-verify after execution, verification failure route-back with preserved FAIL evidence, and Goal Fit stop behavior. Review remains report-only critique recorded in `critique.json`; verification remains evidence recorded in `evidence.json`. Open critique findings or verification failure route back through execution before the loop can be delivered.

Evidence tiers:

| Tier | Meaning |
| --- | --- |
| `adapter` | Runtime adapter transforms hook output into the target runtime protocol; proves protocol delivery shape, not live model influence. |
| `installed-command` | The exported hook command runs from installed Codex, Claude Code, and Kiro bundle paths and emits the expected guidance. |
| `live-acceptance` | A live runtime session shows the agent responding differently because hook guidance reached the model or runtime stop gate. |
| `documented-runtime-gap` | The runtime is covered by adapter or installed-command evidence, but a live harness cannot yet prove model-context influence. |
| `design-target` | Expected behavior is captured as an executable fixture contract, but implementation or live harness evidence is intentionally deferred. |

Use the Flow Agents CI baseline as the provider evidence lane for this deterministic coverage:

```bash
bash evals/ci/run-baseline.sh
```

For GitHub provider evidence, cite the relevant uploaded lane artifact/check: `flow-agents-ci-source-and-static`, `flow-agents-ci-workflow-contracts`, or `flow-agents-ci-runtime-and-kit`. Those artifacts are provider evidence for deterministic local contracts and installed-command behavior. They intentionally skip live LLM influence checks unless separately configured, so they must not be cited as proof that Codex live model context was changed by project hooks.

Run the non-LLM hook-influence contract with:

```bash
bash evals/integration/test_hook_influence_cases.sh
```

Example Codex profile comparison:

```bash
npm run usage-feedback -- report \
  --telemetry-dir .telemetry/codex-default \
  --telemetry-dir .telemetry/codex-bedrock \
  --runtime codex \
  --group-by profile_id
```

Telemetry import is runtime-neutral. Use `import-telemetry --runtime <runtime>` for Kiro, Codex, Claude Code, or future runtimes that emit the shared event envelope; `import-codex` remains a compatibility alias for Codex full logs.

```bash
npm run usage-feedback -- import-telemetry \
  --runtime claude-code \
  --input-telemetry-dir /path/to/project/.telemetry \
  --telemetry-dir .telemetry/claude
```

## Release Criteria

Workflow changes are ready to release when:

- static contract evals pass
- relevant behavioral cases pass or have documented runtime blockers
- hook-influence behavioral cases validate and any runtime gaps are explicitly marked
- artifact quality checks cover changed artifact contracts
- adversarial cases exist for any newly added gate behavior
- end-to-end evals pass for workflow release candidates
- `bash evals/integration/test_workflow_artifacts.sh` passes for shared-contract artifact changes
- generated bundle docs and skill maps agree on owners, gates, artifacts, and deferred primitives

## Runtime Notes

Behavioral results must record which runtime is being evaluated: Codex or Kiro. A pass in one runtime does not automatically prove the other unless the prompt path, tools, and skill-loading behavior are equivalent.
