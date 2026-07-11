---
name: "continue-work"
description: "Explicit Builder Kit continuation extension. Prepares a fresh-context handoff for the next unfinished increment of a multi-slice Work Item."
---

# Continue Work

## Role and Boundary

**Role:** explicit continuation extension outside generic routing.

Use only when the user explicitly asks to advance the next unfinished increment
of a multi-slice Work Item that has prior completed increments. This extension
does not select a new flow, resume an interrupted increment, or run build
steps in-line. It prepares a fresh-context handoff that routes the next
increment through the normal `builder.build` entrypoint.

It owns **no step-gate evidence**. `pull-work`, `design-probe`, and the build
primitives own selection, probe, planning, execution, review, and verification
evidence.

## Inputs and Provider Adapters

Use the Work Item adapter for slice status and acceptance context, the Board
adapter for selection and dependencies, the Repository adapter for local
history and working agreements, and the Change adapter for prior completed
increments. GitHub issues and pull requests are optional examples of Work Item
and Change adapters, not mandatory inputs.

Restore durable context when available: prior plans, handoffs, verified
outcomes, completed changes, and unresolved blockers. If it is unavailable,
state the gap and rely on the Work Item and repository history without
inventing missing facts.

## Extension Behavior

1. Confirm this is the next increment, not a restart of the same interrupted
   increment. Ask one focused question when that boundary is unclear.
2. Determine the thinnest remaining meaningful slice from the Work Item and
   completed Change-adapter history.
3. Build a minimal fresh-context handoff containing the next slice, acceptance
   context, repository working agreements, relevant prior changes, known
   blockers, and adapter references.
4. Hand the new context to `deliver`, which starts or continues `builder.build`
   and routes the item through its canonical primitives.

Do not repeat the detailed `pull-work` or `design-probe` procedure, attach
evidence on their behalf, or treat a continuation request as authority to skip
selection and probe work.

## Output Responsibility

The output is a concise, ephemeral fresh-context handoff delivered to a new
agent or operator. It creates no persistent artifact, trust slice, or gate
evidence of its own.

## Standalone and No-Active-Run Behavior

This extension may run without an active workflow run because it only prepares
the next handoff. It does not create, recover, or mutate a run. If an active
run exists, inspect it only through `flow-agents workflow status --session-dir
<session-dir>` and do not redirect or advance it. For an interrupted current
increment, route to the run's public resume behavior instead of using this
extension.
