---
title: Kit observability contribution contract
---

# Kit observability contribution contract

Issue #911 defines an optional, host-neutral declaration for a Flow Agents Kit that wants operational projections consumed by Console, Station, or another host. It is a **read contract**: a Kit owns projection semantics and references; a host owns installation, enablement, rendering, storage policy, authentication, tenancy, and every provider operation. Headless Kit execution remains complete when no host is installed.

The contract never creates a Flow transition, satisfies a Flow gate, derives a Surface claim, or authorizes a host to mutate a Kit lifecycle. `flow`, `surface`, and `runtime` references identify authority a host must consult; they are not copies of that authority.

## Discovery, lifecycle, and compatibility

An opting-in `kit.json` adds one portable declaration:

```json
"observability_contribution": { "path": "kit-observability.contribution.json" }
```

The path is a relative in-Kit path and is resolved with `realpath`; a descriptor symlink that resolves outside the Kit is rejected. The descriptor is a Kontour Resource Contract-shaped record with `apiVersion`, `kind`, `metadata`, and `spec`; its v1 values are `flowagents.kontourai.io/v1alpha1`, `KitObservabilityContribution`, and contract version `1.0`.

Hosts call `loadKitObservabilityContribution(kitDir)` for discovery and then `negotiateKitObservabilityContribution(result, hostState)` for their own lifecycle state. Negotiation is deliberately a host input, never a field a Kit can mutate:

| Result | Meaning | Underlying Kit |
| --- | --- | --- |
| `enabled` | Installed and enabled; required host capability exists. | Continues normally. |
| `disabled` | Absent, not installed, or host-disabled optional contribution. | Continues headlessly. |
| `incompatible` | Descriptor/host contract version or required capability cannot be negotiated. | Continues headlessly. |

Diagnostics are typed (`contribution_absent`, `contribution_disabled`, `contribution_not_installed`, `unsupported_contract_version`, `host_contract_version_unsupported`, and capability diagnostics), so a host can report the exact disabled or incompatible reason without inventing behavior. Kit-repository validation surfaces an unsupported descriptor as a non-blocking warning; a malformed opted-in local descriptor remains an error.

## Descriptor contents and host capability negotiation

`spec.projections` is a map from supported projection kind to its Kit-owned schema reference. `spec.authority_refs` is likewise a map, avoiding duplicated Kit ids, projection kinds, view subsets, and authority lists. v1 supports `run_summary`, `metric_series`, `queue`, `grounded_narrative`, and `learning` projections.

Every v1 descriptor requires `standard_views`, optionally requests `mcp_apps_resource_bridge`, and declares `mcp_apps_resource_bridge` as its preferred presentation with `standard_views` as its fallback. A host that supports the official MCP Apps resource/bridge presents that negotiated view; otherwise it renders the same declaration with standard views. A host plugin/server is optional negotiated infrastructure, not a second contract or source of lifecycle authority.

`operator_intents` is closed to three host-governed, capability-gated intents:

- `open_resource` requires `resource.open` and names only an authority and resource kind.
- `export_local` requires `export.local`.
- `review_proposal` requires `proposal.review` and names the Surface proposal kind.

Portable v1 has no provider command, executable ref, lifecycle endpoint, or direct mutation intent. Consequently privileged/direct lifecycle mutation is unrepresentable in the descriptor. A host may make an available intent actionable only through its own authenticated, authorized provider integration; otherwise it reports `operator_intent_capability_unavailable` and keeps the Kit operational.

Published structural schemas are [kit-observability-contribution.schema.json](../schemas/kit-observability-contribution.schema.json) and [kit-observability-record.schema.json](../schemas/kit-observability-record.schema.json). The shipped typed validator and JSON Schema reject the same local descriptor faults; conformance includes parity cases for unknown fields, missing projection schemas, presentation changes, unsupported capabilities, and forbidden executable-style refs. Descriptor-to-record linkage (matching `contribution_ref` and declared projection) is intentionally semantic validation because it needs the loaded descriptor, while every individual record shape is schema-validated.

## Author and host conformance

Builder and Knowledge provide real descriptors at `kits/<kit>/kit-observability.contribution.json`. The synthetic third-party fixture at `evals/fixtures/kit-observability/third-party-kit/` uses the identical `kit.json` declaration and has no host-specific branch. Host-state fixtures exercise disabled, uninstalled, capability-limited, MCP-enabled, and incompatible negotiation without a Console release.

An authored record is a `KitObservabilityRecord` with a descriptor `contribution_ref`, a declared projection kind, and Kit-defined data. It cannot include top-level `gate` or `claim` authority in its data. The `data` value is opaque, Kit-schema-owned payload: generic hosts do not recursively interpret it as Flow or Surface state, and the Flow gate resolver and Surface claim derivation do not consume this record type. Nested domain fields such as `domain.gate` therefore remain valid Kit data but cannot confer lifecycle or trust authority. Store non-durable generated projection output under `.kontourai/flow-agents/`; durable decisions continue to live in their owning ledger or provider.

Run the conformance test headlessly from this repository:

```sh
bash evals/static/test_kit_observability_contract.sh
```
