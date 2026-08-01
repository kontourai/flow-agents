---
title: Kit observability contribution contract
---

# Kit observability contribution contract

Issue #911 defines an optional, host-neutral declaration for a Flow Agents Kit that wants its operational projections consumed by Console, Station, or another host. It is a **read contract**: a Kit owns projection semantics and references; a host owns rendering, storage policy, authentication, tenancy, and operator interaction. Headless Kit execution remains complete when no host is installed.

The contract does not create a Flow transition, satisfy a Flow gate, derive a Surface claim, or authorize a host to mutate a Kit lifecycle. `flow`, `surface`, and `runtime` references identify the authority a host must consult; they are not copies of that authority.

## Discovery and compatibility

An opting-in `kit.json` adds one portable declaration:

```json
"observability_contribution": { "path": "kit-observability.contribution.json" }
```

The path stays inside the Kit. The descriptor is a Kontour Resource Contract-shaped record with `apiVersion`, `kind`, `metadata`, and `spec`; its v1 values are `flowagents.kontourai.io/v1alpha1`, `KitObservabilityContribution`, and contract version `1.0`.

Hosts import `@kontourai/flow-agents/kit-observability-contract` and call `loadKitObservabilityContribution(kitDir)`. It returns one of:

- `supported` with a validated descriptor;
- `absent` with `contribution_absent` — optional, so the host simply has no Kit view;
- `invalid` with `invalid_contribution` — the underlying Kit still runs headlessly;
- `unsupported` with `unsupported_contract_version` — the host must show the compatibility gap honestly and must not guess a fallback interpretation.

Kit-repository validation surfaces an unsupported contribution as a non-blocking warning: the optional host view is unavailable, but the underlying Kit remains valid and headless. A malformed declared descriptor remains an error because an author opted in with an invalid local contract.

## Descriptor contents

`spec` declares the Kit id and contribution version, projection kinds plus their Kit-owned schema references, supported view kinds, and canonical `flow`, `surface`, and `runtime` references. v1 supports `run_summary`, `metric_series`, `queue`, `grounded_narrative`, and `learning` projections.

It also requires explicit local-export/sink capability, redaction/retention/raw-source policy, and operator actions. Actions are only a `provider_command` or a `proposal_ref`; they are provider-routed read/navigation/proposal references, never a direct lifecycle mutation.

Published structural schemas are [kit-observability-contribution.schema.json](../schemas/kit-observability-contribution.schema.json) and [kit-observability-record.schema.json](../schemas/kit-observability-record.schema.json). The exported typed validators enforce the additional cross-record invariants: a record must name a descriptor-declared projection and preserve its authority references.

## Author and host conformance

Builder and Knowledge provide real fixtures at `kits/<kit>/kit-observability.contribution.json`. The synthetic third-party fixture at `evals/fixtures/kit-observability/third-party-kit/` uses the identical `kit.json` declaration and has no host-specific source branch.

An authored record is a `KitObservabilityRecord` with a matching contribution id/version, declared projection kind/schema reference, authority refs, and Kit-defined data. It cannot include top-level `gate` or `claim` authority in its data. The `data` value is opaque, Kit-schema-owned payload: generic hosts do not recursively interpret it as Flow or Surface state, and the Flow gate resolver and Surface claim derivation do not consume this record type. Nested domain fields such as `domain.gate` therefore remain valid Kit data but cannot confer lifecycle or trust authority. Store non-durable generated projection output under `.kontourai/flow-agents/`; durable decisions continue to live in their owning ledger or provider.

Run the conformance test headlessly from this repository:

```sh
npm run test:unit -- --test-name-pattern='Kit observability'
```
