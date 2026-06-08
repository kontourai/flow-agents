---
title: Standards Register
---

# Standards Register

Flow Agents should reuse durable standards and common conventions before inventing local formats. This register records the standards Flow Agents intends to align with and where Flow Agents-owned schemas may still be needed.

## Adoption Policy

Use an existing standard when it covers the job well enough.

Invent a Flow Agents format only when:

- no durable standard fits the artifact
- the format is small and purpose-specific
- the format has a JSON Schema or equivalent contract
- the artifact is human-inspectable or has a readable companion summary
- the artifact can be exported to a common format when practical

Avoid private formats for skills, repo instructions, contacts, calendars, API descriptions, security findings, dependency provenance, or telemetry when a widely used standard exists.

## Standards

| Area | Standard / Convention | Flow Agents Use |
| --- | --- | --- |
| Repo guidance | `AGENTS.md` | Project-level instructions and durable agent guidance. |
| Source language | TypeScript-first source policy | Product/runtime source should default to TypeScript across Kontour repositories, with narrow JS/MJS exceptions. See `docs/adr/0006-typescript-first-source-policy.md`. |
| Skills | Agent Skills / `SKILL.md` | Reusable capability packages with progressive disclosure. |
| Tools | MCP | Tool, resource, prompt, and integration exposure. |
| API contracts | OpenAPI | HTTP/service integration descriptions. |
| Auth | OAuth/OIDC | Delegated access and identity boundaries for integrations. |
| Resource contracts | Kontour Resource Contract | Kubernetes-inspired, runtime-neutral durable records for Flow Agents scope, workflow state, evidence pointers, provider output, and interchange. See `docs/kontour-resource-contract.md`. |
| Workflow state | JSON Schema | Flow Agents-owned state, criteria, handoff, evidence, critique, release, and learning sidecars. |
| Telemetry | OpenTelemetry logs/traces and GenAI conventions | Runtime, workflow, tool, model, and eval event alignment. Evidence sidecars reference native OpenTelemetry records instead of copying them. |
| Findings | SARIF | Code review, security, static analysis, and policy finding interchange where applicable. Evidence sidecars reference native SARIF runs/results. |
| Supply chain | CycloneDX, SLSA | Dependency, SBOM, provenance, and release-trust workflows. |
| Contacts | JSContact, vCard where needed | Person and relationship records. |
| Calendar | iCalendar, CalDAV | Meetings, events, reminders, and schedule references. |
| Mail/data sync | JMAP | Future-facing mail, contacts, and calendar sync model. |
| Transcripts | WebVTT/SRT | Meeting and video transcript import/export. |
| Notes | CommonMark, Markdown frontmatter | Durable human-readable knowledge artifacts. |
| Structured knowledge | JSON-LD, schema.org | Portable people, organization, event, action, and relationship metadata when useful. |
| Agent-to-agent | A2A | Watch and integrate only where it helps cross-runtime delegation. |
| Documentation discovery | `llms.txt` | Track as emerging; use for docs discovery when it becomes stable enough. |

## Flow Agents-Owned Formats

Flow Agents may need local schemas for reliability glue that existing standards do not define cleanly.

| Format | Purpose | Target Location | Status |
| --- | --- | --- | --- |
| Workflow state | Current phase, owner, next action, status, and resumability data | `.agents/flow-agents/<slug>/state.json` | Draft schema: `schemas/workflow-state.schema.json` |
| Acceptance criteria | Criteria, source request, evidence requirements, and goal-fit status | `.agents/flow-agents/<slug>/acceptance.json` | Draft schema: `schemas/workflow-acceptance.schema.json` |
| Evidence summary | Proof commands, standard refs, skipped checks, not-verified gaps, and external evidence links | `.agents/flow-agents/<slug>/evidence.json` | Draft schema: `schemas/workflow-evidence.schema.json` |
| Handoff | What another agent or future session needs to continue safely | `.agents/flow-agents/<slug>/handoff.json` | Draft schema: `schemas/workflow-handoff.schema.json` |
| Critique record | Reviewer passes, findings, severity, and resolution state for critique loops | `.agents/flow-agents/<slug>/critique.json` | Draft schema: `schemas/workflow-critique.schema.json` |
| Release readiness | Merge, release, deploy, hold, rollback, docs, and operational readiness decisions | `.agents/flow-agents/<slug>/release.json` | Draft schema: `schemas/workflow-release.schema.json` |
| Learning record | Repeated failure, correction, pattern, and recommended system update | `.agents/flow-agents/<slug>/learning.json` or `.telemetry/outcomes.jsonl` | Draft schema: `schemas/workflow-learning.schema.json` |
| Context map | Compact project map: structure, commands, conventions, test strategy, packs, and recent state | Generated under `.agents/flow-agents/` or configurable cache | Planned |
| Pack manifest | Core and optional pack composition for a target install | `packaging/packs.json` plus generated export catalog metadata | Draft manifest: `packaging/packs.json` |
| Governance adapter | Optional bridge from Flow Agents evidence gates to tools such as Veritas | `context/contracts/governance-adapter-contract.md` | Draft contract |

These formats should be treated as contracts once introduced. Breaking changes require schema version bumps and migration notes.

## Integration Boundaries

Flow Agents should integrate with external systems through narrow adapters.

For example, Veritas can own repo-local standards, authority settings, evidence checks, JIT `explain`, and evidence records. Flow Agents can invoke Veritas and ingest its output without taking ownership of Veritas policy semantics.

The adapter contract is `context/contracts/governance-adapter-contract.md`.

Evidence adapters should preserve native proof when possible:

- Static analysis, review, security, and policy findings should point to SARIF artifacts when the source can produce them.
- Runtime and workflow events should point to OpenTelemetry logs or traces when available.
- Test runner output should point to JUnit, TAP, or the runner's native artifact when available.
- Veritas output should be recorded as an optional `standard_refs` or `external_evidence` entry with `standard: "veritas"`.

That pattern should apply broadly:

- Let specialized tools own their native model.
- Map their output into Flow Agents evidence or knowledge records.
- Keep adapters optional unless the capability is required for the core experience.

## Review Questions

Before merging a new schema, file format, or artifact:

- Which standard did we check first?
- Why was it insufficient?
- Is the new format schema-described?
- Is there a human-readable representation?
- Can another tool consume or export it?
- Does this belong in core or an optional pack?
