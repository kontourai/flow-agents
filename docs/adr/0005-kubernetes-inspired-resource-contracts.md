# ADR 0005: Kubernetes-Inspired Kontour Resource Contracts

Date: 2026-05-27

## Status

Accepted

## Context

Kontour products need durable records that humans, agents, runtime adapters, provider integrations, CLI tools, CI systems, evals, and future control planes can all inspect without relying on hidden chat context. Kubernetes, Tekton, and Argo have converged on versioned resource shapes with metadata, desired state, observed status, and status conditions; that shape is familiar, toolable, and a good fit for workflow state. OpenTelemetry GenAI conventions are also emerging for agent observability, so Kontour products should not invent isolated telemetry concepts where compatible conventions already exist.

## Decision

New durable, agent-facing, provider-facing, CLI-facing, cross-product, or user-authored Kontour contracts will use a Kubernetes-inspired Kontour Resource Contract shape by default: versioned resource identity, metadata, desired intent, observed status, and condition-style status summaries. Flow Agents is the first adopter, and current pre-public contracts in Flow, Surface, and Veritas should be audited for migration rather than grandfathered automatically.

Kontour Resource Contracts do not create a Kubernetes dependency; local files and provider-backed records remain first-class, and a Kubernetes operator is only a possible future adapter over the same contracts. Product namespaces should distinguish owners, such as `flow.kontourai.io/v1alpha1`, `flowagents.kontourai.io/v1alpha1`, `builder.flowagents.kontourai.io/v1alpha1`, `surface.kontourai.io/v1alpha1`, and `veritas.kontourai.io/v1alpha1`.

Products may keep product-native internal types when they are materially clearer, but exported durable artifacts should converge on Kontour Resource Contracts or document an explicit mapping and exception.

## Consequences

Positive:

- Agents can reason about durable product state without bespoke parsing for every artifact.
- Runtime adapters, provider adapters, CLI tools, CI systems, evals, and the future Console can share one contract style.
- Active Workflow Runs can publish Selected Scope metadata for future overlap checks.
- Future Kubernetes operator support remains possible without making Kubernetes the default runtime.

Trade-offs:

- Kontour products must avoid turning every concept into a resource.
- Status must stay disciplined: intent belongs in the desired-state portion of a contract, observed facts belong in status, and evidence records remain separately inspectable.
- Existing pre-public sidecars and exported artifacts need migration plans or documented exceptions instead of accidental grandfathering.

## Alternatives Considered

### Ad Hoc JSON Sidecars

Rejected as the long-term direction because ad hoc sidecars are easy to create but hard for adapters, evals, providers, and users to understand consistently.

### Depend Directly On Kubernetes CRDs

Rejected because Flow Agents must remain local-first and runtime-neutral. Kubernetes may become an adapter target, not the substrate required to use Flow Agents.
