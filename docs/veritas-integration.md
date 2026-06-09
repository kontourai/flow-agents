---
title: Veritas Integration Boundary
---

# Veritas Integration Boundary

Veritas is a strong fit for Flow Agents' development evidence and governance layer, but it should stay optional and adapter-driven.

The guiding rule is simple: Flow owns generic process enforcement, Flow Agents projects Flow-backed workflows into agent harnesses, and Veritas owns repo-local standards, authority, and evidence-check semantics.

## User-Facing Story

The user should not need to know which tool produced a policy check.

```text
User: Keep going until the change is ready.

Flow Agents:
1. Plans the work.
2. Executes or delegates scoped changes.
3. Runs normal verification.
4. If Veritas is configured, asks Veritas for repo-local readiness evidence.
5. Records the Veritas artifact as gate evidence in the Flow-backed workflow state.
6. Continues, blocks, or asks for a decision based on the Flow gate outcome.
```

The user sees a clear result: pass, fail, hold, or not verified. The implementation detail is that one evidence source may be Veritas.

## Ownership Split

| Area | Flow Agents Owns | Veritas Owns |
| --- | --- | --- |
| Workflow | Agent-facing workflow packs, harness hooks, sidecars, release decisions, learning loops | None |
| Flow | Process steps, gates, transitions, Flow Runs, exceptions, and Flow Reports | None |
| Governance | When to ask for governance evidence | Repo standards, authority settings, evidence checks |
| Evidence | `evidence.json`, `standard_refs`, `external_evidence`, acceptance mapping | Native Veritas reports and rule results |
| UX | Plain-language next action and user decision points | Explain output for policy/rule details |
| Packaging | Optional power/adapter wiring | Veritas installation and configuration |

Flow Agents may use Flow terminology internally as Flow is extracted, but Veritas evidence should remain a compact provider result. Do not copy Veritas requirements into Flow or Flow Agents workflow definitions.

## Adapter Contract

Flow Agents should integrate through the governance adapter contract:
https://github.com/kontourai/flow-agents/blob/main/context/contracts/governance-adapter-contract.md

The optional TypeScript adapter is available through:

```bash
npm run veritas-governance -- evidence \
  --artifact-dir .flow-agents/<task-slug> \
  --repo-root . \
  --veritas-bin veritas \
  --veritas-artifact .veritas/readiness/evidence.json \
  --max-age-seconds 3600
```

By default the adapter invokes:

```bash
veritas readiness --check evidence --working-tree
```

Use `--veritas-bin <path-or-command>` to point at a local Veritas checkout, wrapper, or fixture. Use `--repo-root <path>` to choose the working directory for the Veritas process. Use `--veritas-root <path>` to append `--root <path>` to the Veritas command. Use `--evidence-path <path>` when the caller wants to write a sidecar somewhere other than `<artifact-dir>/evidence.json`. Use `--max-age-seconds <n>` to mark a configured native artifact stale after a caller-selected threshold.

When Veritas runs, Flow Agents records a normal evidence check with a standard ref and top-level external evidence reference:

```json
{
  "schema_version": "1.0",
  "task_slug": "example-task",
  "verdict": "pass",
  "checks": [
    {
      "id": "veritas-governance-evidence",
      "kind": "policy",
      "status": "pass",
      "summary": "Veritas readiness evidence completed without blocking findings.",
      "standard_refs": [
        {
          "standard": "veritas",
          "ref": "/repo/.veritas/readiness/evidence.json",
          "role": "native",
          "summary": "Native Veritas readiness evidence artifact."
        }
      ]
    }
  ],
  "external_evidence": [
    {
      "system": "veritas",
      "standard": "veritas",
      "ref": {
        "kind": "external",
        "url": "file:///repo/.veritas/readiness/evidence.json"
      },
      "summary": "Native Veritas readiness evidence artifact."
    }
  ]
}
```

The adapter maps native Veritas artifacts only by reference. It writes `kind: "policy"`, `standard_refs[].standard: "veritas"`, and top-level `external_evidence` entries with `standard: "veritas"`. It does not add Veritas-specific fields to Flow Agents schemas or copy native rule details into Flow Agents sidecars.

If Veritas is unavailable and the workflow expected it, record `not_verified` instead of inventing a pass. The adapter records `not_verified` when the executable is missing, Veritas exits nonzero, the configured native artifact is missing or unreadable, or the artifact is older than the freshness threshold. `--not-configured` records `not_verified` without invoking Veritas. `--skip` records an explicit skipped policy check when the caller intentionally opts out.

## Builder Kit Trust Evidence

Builder Kit gates stay provider-neutral. The Builder Kit Flow Definition names gate expectations as `kind: "surface.claim"` and declares the claim type, subject, accepted statuses, and blocking behavior. It does not name Veritas or any other trust producer.

When a trust-backed path is configured, Flow Agents may attach a compact Surface-shaped reference to the Builder Kit evidence gate. The reference points at a TrustReport or Trust Snapshot, carries the related gate id, Surface claim type, claim status, artifact ref, integrity summary, authority or trusted-producer summary, subject, and freshness state, and then maps to the normal Flow gate result. Flow owns the gate authority decision, route reason, trusted producer mapping, and accepted gap behavior. Surface owns the portable trust state represented by the Surface claim and the TrustReport / Trust Snapshot. A Probe can request or clarify the evidence needed before planning or before a later Builder Kit gate retries.

Veritas is only one optional producer of those artifacts. A local Veritas readiness run can emit native Veritas evidence and, when configured, point Flow Agents at a Surface-shaped TrustReport or Trust Snapshot. Flow Agents records the reference; it does not copy Veritas rule models, readiness semantics, or provider-native fields into Builder Kit gates.

Provider and artifact absence are explicit:

- If no trust provider is configured, ordinary Builder Kit activation, planning, verification, and evidence gates continue to work through the existing Flow Kit path.
- If a trust-backed path was requested but no provider is configured, the trust check records `not_verified` with a clear gap instead of blocking unrelated Builder Kit usage.
- If a provider is configured but the expected TrustReport or Trust Snapshot is absent or unreadable, only the requested trust-backed evidence check records `not_verified`; it does not silently pass and it does not make Veritas mandatory.
- If a TrustReport or Trust Snapshot is present but has a rejected, stale, expired, missing-authority, or integrity-mismatched Surface claim, the Builder Kit evidence gate routes through the normal `fail` or `not_verified` path.

## Adoption Gate

Before making Veritas a first-class Flow Agents power, prove:

- Veritas can run in advisory readiness mode without becoming a hard dependency.
- Veritas output maps cleanly into `evidence.json`.
- Veritas rule failures produce actionable Flow Agents next actions.
- Non-development and knowledge workflows do not pay a context or install penalty.
- The integration improves reliability faster than a smaller Flow Agents-only checker.

## Current Integration Shape

Flow Agents should not introduce a repo-specific Python wrapper as the Veritas integration surface. Until the integration is worth productizing, run Veritas directly from the Veritas checkout or published package and record only compact evidence references in Flow Agents sidecars.

The forward path is a small TypeScript adapter or package command that:

- invokes Veritas readiness without copying Veritas rule schemas into Flow Agents
- stores native Veritas output under `.veritas/` or a caller-selected external evidence directory
- records a compact `evidence.json` reference through the Flow Agents sidecar writer
- fails honestly with `NOT_VERIFIED` when Veritas was expected but unavailable or unreadable

That adapter exists now as `flow-agents veritas-governance evidence`. It is intentionally optional and fixture-tested; ordinary Flow Agents validation and delivery workflows do not require a live Veritas installation.

Veritas source and CLI details live in the Veritas repository:
https://github.com/kontourai/veritas

Current local configuration in this repo is limited to:

1. Flow Agents adapter metadata under `integrations/veritas/`.
2. Repo standards that Veritas may evaluate:
   - instruction governance files stay intact
   - workflow contract changes require eval updates
   - hook/script changes require validation evidence
3. A provider-neutral evidence contract for recording the result back into Flow Agents workflow state.

## Non-Goals

- Do not vendor Veritas source into Flow Agents.
- Do not make Veritas mandatory for the core pack.
- Do not duplicate Veritas policy schemas inside Flow Agents.
- Do not make knowledge, meeting, or sales workflows depend on development governance tooling.
- Do not bootstrap `.veritas/repo-map.json` from Flow Agents in this slice. Native Veritas repository setup remains future Veritas-owned or adapter-owned work.

This keeps Veritas aligned with the north star without letting one optional governance provider define the whole Flow Agents architecture.
