# Governance Adapter Contract

> Read [`context/contracts/standing-directives.md`](standing-directives.md) — ratified owner directives that override default engineering conservatism.

Governance adapters let Flow Agents ask an external tool for policy, proof, or trust evidence without baking repo-specific policy into Flow Agents core.

## Boundary

Flow Agents owns:

- workflow phase routing
- acceptance criteria and goal-fit checks
- `evidence.json` references to external proof
- release, learning, and handoff decisions

The adapter owns:

- repo-local policy semantics
- evidence check selection and execution
- native evidence artifact shape
- rule explanations and just-in-time guidance
- policy promotion or retirement logic

Flow Agents must not copy an adapter's rule model into core skills. It should invoke the adapter when configured, record the artifact reference, and route the resulting pass/fail/not-verified status through normal evidence gates.

## Minimum Adapter Shape

An adapter integration should define:

- `id`: stable adapter id, such as `veritas`
- `availability_check`: command or file probe that proves the adapter is installed/configured
- `readiness_command`: optional command that explains required proof or verification budget
- `evidence_command`: command that produces a native evidence artifact or machine-readable result
- `feedback_command`: optional command that emits concise agent-facing guidance
- `artifact_pattern`: where native evidence artifacts are written
- `standard`: evidence standard used in Flow Agents sidecars, such as `veritas`, `sarif`, or `opentelemetry-log`
- `sandbox_mode`: minimum mode required by `context/contracts/sandbox-policy.md`
- `failure_routing`: whether failures return to planning, execution, verification, release readiness, or human decision

## Veritas Boundary

Veritas is the first known fit for this contract.

Use Veritas when a repo has Veritas configuration and the work needs repo-local standards, authority, evidence checks, readiness, or JIT rule guidance.

Do not require Veritas for the Flow Agents core surface or Builder Kit. Treat it as an optional development/governance provider:

- `veritas readiness --check evidence --working-tree`: readiness evidence, native report, and feedback draft
- `veritas readiness --check boundaries --working-tree`: protected-area and ownership signal
- `veritas readiness --check coverage --working-tree`: evidence coverage signal
- `veritas explain <rule|file|surface>`: just-in-time guidance

When a Veritas artifact is used, write a Flow Agents evidence check with `standard_refs[].standard: "veritas"` and `standard_refs[].ref` pointing at the Veritas artifact. If the artifact is outside the workflow directory, also add `external_evidence`.

## Stop Conditions

Stop and route to the user or plan when:

- the adapter is not installed or configured and the plan requires it
- the adapter needs a stronger sandbox mode than the plan recorded
- the adapter reports blocking policy failures
- the adapter output cannot be tied to changed files, acceptance criteria, or release risk
- the native evidence artifact is missing or unreadable

## Non-Goals

- Do not turn adapter-specific rules into Flow Agents universal rules.
- Do not make Veritas or any governance adapter mandatory for ordinary Flow Agents usage.
- Do not flatten native evidence artifacts into long Markdown summaries when a stable artifact reference is available.
