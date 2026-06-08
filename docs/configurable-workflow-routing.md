---
title: Configurable Workflow Routing
---

# Configurable Workflow Routing

Configurable workflow routing is the design for choosing which provider or profile should handle each Flow Agents workflow slot. It belongs to the workflow and agent/provider-selection layer: it names who should plan, implement, review, or verify, while the workflow contracts still own state, gates, artifacts, and evidence.

This page is a design target. Flow Agents does not yet load a routing config or change runtime behavior from these examples.

## Compatibility

No config means current behavior. If a repo or user has no routing config, the active harness, current agent profile, skills, workflow contracts, and sidecar rules behave exactly as they do today.

The first implementation slices should preserve that rule. Routing config should be opt-in, inspectable, and easy to diagnose before it affects execution.

## Start With One Provider

The simple case is a single default provider. A user should not need to learn adapter internals, consensus backends, or advanced lane policy to say "use this provider for normal Flow Agents work."

Future config may look like this:

```yaml
providers:
  codex:
    cli: codex

profiles:
  default:
    default: codex
```

In this shape, every workflow slot resolves to `codex` unless a later slot override says otherwise. Planning, implementation, review, and verification still follow the same contracts from the Workflow Usage Guide and Shared Workflow Contracts:
https://github.com/kontourai/flow-agents/blob/main/docs/workflow-usage-guide.md
https://github.com/kontourai/flow-agents/blob/main/docs/workflow-shared-contracts.md

## Slots

Slots are the workflow moments where provider choice matters. They use Flow Agents workflow vocabulary, not tool-specific command names.

| Slot | Meaning | Typical workflow owner |
| --- | --- | --- |
| `plan` | Shape an accepted work item into an implementation plan with acceptance criteria and file ownership. | `plan-work` |
| `implement` | Make source changes from the approved plan and record progress. | `execute-plan` |
| `review` | Critique the result for quality, security, correctness, or consensus findings. | critique, evidence, or review agents |
| `verify` | Run checks, map evidence to acceptance criteria, and report `PASS`, `FAIL`, or `NOT_VERIFIED`. | `verify-work` |

Slot overrides let a profile keep one default provider while choosing stronger or cheaper options for specific phases:

```yaml
providers:
  codex:
    cli: codex

  claude-opus:
    cli: claude
    model: opus

profiles:
  default:
    default: codex
    slots:
      plan: claude-opus
      implement: codex
      review: claude-opus
      verify: codex
```

This says: use the default provider for ordinary work, ask `claude-opus` to plan and review, and keep implementation and verification on `codex`.

## Consensus Review

`consensus` is a Flow Agents review concept. It means more than one reviewer perspective is used for a read-only critique, and the result is normalized into Flow Agents review, critique, or evidence artifacts.

Users should be able to request consensus without knowing which backend produced it:

```yaml
providers:
  codex:
    cli: codex

  claude-opus:
    cli: claude
    model: opus

  consensus-review:
    mode: consensus
    reviewers:
      - claude-opus
      - codex

profiles:
  default:
    default: codex
    slots:
      plan: claude-opus
      implement: codex
      review: consensus-review
      verify: codex
```

A future backend may use native subagents, separate CLI profiles, or optional MCO infrastructure to run the reviewers. That backend is not the first-class API. The user-facing promise is that consensus remains read-only review behavior and produces findings that Flow Agents can map into its normal artifact contracts.

Consensus review is not implementation routing. It should not write production files, bypass verification, or replace evidence gates.

## Advanced Lanes

Lanes are deferred guarded overrides for bounded work. They are not a route named after task size, and this design does not define or enable runtime lane behavior yet.

A lane should eventually answer questions like:

- What kinds of work are allowed in this lane?
- Which files or directories are in scope?
- Which provider or profile may implement it?
- Which guardrails, review, and verification must pass before the work is accepted?
- What happens when the work exceeds the lane boundary?

Future config might express a guarded lane like this:

```yaml
lanes:
  docs_only:
    description: Documentation changes with no runtime code edits.
    allow_paths:
      - docs/**
    deny_paths:
      - skills/**
      - agents/**
      - schemas/**
      - scripts/**
      - dist/**
    slots:
      implement: codex
      review: consensus-review
      verify: codex
```

This example documents intent only. Guarded lanes need schema validation, conflict checks, artifact recording, and enforcement before they can safely affect execution.

## Layer Alignment

Routing should stay aligned with Operating Layers:
https://github.com/kontourai/flow-agents/blob/main/docs/operating-layers.md

- Providers and profiles describe agent/provider selection.
- Slots connect provider selection to workflow phases.
- Workflows still own durable state, acceptance criteria, handoffs, and phase transitions.
- Evidence still owns proof, findings, validation output, and release confidence.
- Powers may expose optional tools or backend infrastructure, but they do not define Flow Agents workflow meaning.

That split keeps Flow Agents portable across Codex, Claude Code, Kiro, OpenCode, and future runtimes.

## Non-Goals For This Slice

This design slice does not add:

- runtime config loading
- provider execution
- schema validation
- MCO integration
- consensus result normalization
- guarded lane enforcement
- generated bundle changes

Docs and examples here are vocabulary and rollout guidance for later implementation.

## Follow-Up Slices

1. Config schema and validation: define the config file shape, validate examples, and produce clear errors for unknown providers, slots, profiles, and lane policy.
2. No-op routing resolution: load config and report which provider would handle each slot without changing execution.
3. Consensus review backend: implement read-only consensus review behind a backend boundary and normalize findings into critique or evidence artifacts.
4. Guarded lanes: design and enforce bounded policy overrides after guardrails, path scopes, artifact recording, and fallback behavior are explicit.

Each slice should preserve no-config compatibility and report `NOT_VERIFIED` when a selected provider, backend, or guardrail cannot be inspected.
