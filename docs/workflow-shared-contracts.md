---
title: Shared Workflow Contracts
---

# Shared Workflow Contracts

The workflow system now separates durable process contracts from role-specific instructions.

## Source Of Truth

Shared contracts live in `context/contracts/`:

- `artifact-contract.md`
- `planning-contract.md`
- `execution-contract.md`
- `review-contract.md`
- `verification-contract.md`
- `delivery-contract.md`

These files define the stable rules for artifacts, planning, execution, review, verification, delivery loops, Goal Fit, and final acceptance.

The durable resource shape for selected scope, workflow runs, run plans, status conditions, provider-backed Work Items, and sidecar compatibility direction is documented in the Kontour Resource Contract:
https://github.com/kontourai/flow-agents/blob/main/docs/kontour-resource-contract.md

That reference is docs-only guidance for new resource-shaped contracts and does not migrate current sidecars or require Kubernetes at runtime.

The lifecycle for in-progress and completed workflow artifacts is documented in the Workflow Artifact Lifecycle:
https://github.com/kontourai/flow-agents/blob/main/docs/workflow-artifact-lifecycle.md

Runtime workflow artifacts under `.kontourai/flow-agents/` remain local and ignored. Explicit durable Flow Agents config/install state may live under `.flow-agents/` when documented, but runtime readers do not fall back there. Completed work must promote durable behavior, decisions, contracts, and evidence into long-lived docs, source, schemas, or provider records before merge to `main`.

## How Skills And Agents Use Them

Skills should explain when to run a workflow and how to orchestrate it. They should reference the relevant contract instead of restating the full protocol.

Agents should explain their role-specific behavior. They should follow the relevant contract instead of carrying a second copy of the artifact or verdict format.

This keeps the system portable across Codex, Kiro, Claude Code, and future distributions. Exporters can adapt tool names, paths, and hook syntax, but the workflow rules stay canonical.

## Eval Direction

Static evals check that the contract files exist, that workflow skills and tool agents reference them, and that deep-context behavioral eval cases exist.

Behavioral evals should test whether the agent still preserves the contract after a long prompt or long session history:

- planning still includes Definition Of Done, stop-short risks, and evidence-bearing acceptance criteria
- execution still updates artifacts between waves
- review still records report-only critique in `critique.json`
- verification still reports PASS, FAIL, or NOT_VERIFIED with evidence per criterion
- delivery still completes Goal Fit before final response
- final acceptance still promotes durable docs after CI or merge
