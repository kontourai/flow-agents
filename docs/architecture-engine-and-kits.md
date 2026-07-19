---
title: Engine and Kits
---

# Engine and Kits

**Flow Agents is an engine you build on — not a single product, and not the Builder Kit.** It has two layers:

1. The **engine** is the product-neutral runtime layer: it interprets Flow Definitions, evaluates gates, adapts to host runtimes and harnesses, provides SDK/evidence/trust primitives, and validates Flow Kit containers and Flow Agents extensions.
2. **Kits** are the swappable solution layer: bundles of flows, gates, skills, agents, hooks, docs, adapters, evals, and assets declared by `kit.json` and registered through `kits/catalog.json`.

The engine is what you build on. Kits are what you build with.

> **Flow Agents is not the Builder Kit.** Builder and Knowledge are kits on the engine. The external Veritas Governance Kit proves the same contract works when a first-party solution is maintained and released from another repository. The engine gives no kit special runtime privilege; "official" is a marketplace label, not engine authority.

## The engine

The engine does not encode one product workflow. It supplies the common substrate that lets any kit run through the same install, validation, activation, steering, evidence, and gate-evaluation path.

Concrete engine pieces in this repository include:

- **FlowDefinition interpretation and gates** — kit manifests point at `.flow.json` definitions, and Flow Agents validates and activates those definitions for runtime use. The Kit Authoring Guide shows a minimal Flow Definition with steps, gates, and required evidence, while the built-in examples and the Git-installable Veritas repository demonstrate different real kit shapes.
- **Runtime and harness adapters** — Flow Agents compiles the same canonical policy classes to host surfaces such as Claude Code, Codex, Kiro, opencode, pi, and framework adapters. The Runtime Hook Surface spec defines the runtime-neutral vocabulary.
- **SDK, evidence, and trust primitives** — workflow sidecars, trust bundles, evidence records, command capture, and CI reconciliation give gates something inspectable to evaluate instead of relying on chat memory.
- **Kit validation framework** — `kit.json` is validated as a Flow Kit container, then Flow Agents validates extension fields such as `skills`, `docs`, `adapters`, `evals`, `assets`, `dependencies`, `workflow_triggers`, and `hook_influence_expectations`.

The important boundary: the engine owns the generic process machinery, not the domain workflow. A coding delivery workflow, a knowledge-store workflow, and an agentless CI evidence workflow all pass through the same container and gate model.

## The kits

A kit is a declared bundle. The catalog names available kits; each kit's manifest declares its own assets.

Today `kits/catalog.json` registers three built-in examples, while product kits may live in their owning repositories:

| Kit | Manifest | What it proves |
| --- | --- | --- |
| Builder Kit | `kits/builder/kit.json` | A full agent-facing delivery kit with shape/build/publish-learn flows, many skills, a dependency on Knowledge, and structured `workflow_triggers`. |
| Knowledge Kit | `kits/knowledge/kit.json` | A durable knowledge-store kit with many Flow Definitions, one agent skill, docs, adapters, providers, evals, and its own `workflow_triggers`. |
| Release Evidence Kit | `kits/release-evidence/kit.json` | A minimal flows-only kit for agentless gate evaluation in CI. It has no skills and is not a Builder workflow. |
| Veritas Governance Kit | `https://github.com/kontourai/veritas` | An external first-party kit installed from Git. It consumes the canonical Veritas readiness bundle without moving governance semantics into this engine. |

Those examples are deliberately different. Builder is not the engine. Builder and Knowledge are bundled solutions; Release Evidence is a minimal built-in proof; Veritas Governance is independently owned and distributed through the same public Git-install path available to every external kit.

## Manifest and catalog model

`kits/catalog.json` is the registry of built-in kits. It records the kit id, name, path, and human-facing description.

Each kit directory has a `kit.json` manifest. The shared container fields are small and portable:

- `schema_version`
- `id`
- `name`
- `description` or `product_name`
- `flows`

Flow Agents adds optional extension fields for agent use:

- `skills`
- `docs`
- `adapters`
- `evals`
- `assets`
- `dependencies`
- `workflow_triggers`
- `hook_influence_expectations`

This is the plugin model. A third-party kit uses the same container shape and validation path as the built-in kits. Bring-your-own-kit is not a side channel; it is the extension point.

## Kit-neutral steering

The engine is kit-neutral. No kit gets special runtime branches just because it is built in, first-party, or official.

Kits steer the engine only through structured `workflow_triggers`. For example, Builder declares a trigger for `implementation-work-detected` that points at `builder.build` and names `deliver` as the default skill. Knowledge declares a trigger for `knowledge-capture-detected` that points at `knowledge.ingest` and names `knowledge.knowledge-capture` as the default skill.

The engine renders those structured fields through one steering path. It does not accept freeform kit steering text, and it does not grant runtime privilege based on provenance.

`first_party` is legacy catalog or marketplace metadata. It can help a marketplace label a kit, but it does not change runtime authority. Built-in, official, and community kits all participate through the same manifest, catalog, activation, and trigger model.

## Marketplace direction

The growth path is a marketplace of kits, not a growing list of hardcoded engine behaviors.

The pieces already in the repository are the same pieces a marketplace needs:

- `catalog.json` as the registry shape for discoverable kits.
- `kit.json` as the manifest and identity document.
- validation as the admission check before install or activation.
- kit identity and trust metadata as marketplace labels, not runtime privilege.
- activation paths that copy declared assets without making one kit special.

That means a team can bring its own kit for a domain workflow, install it, validate it, activate it, and have it steer through the same structured trigger model as the built-in kits.

## Trust posture

Kit trust is orthogonal to engine privilege. A marketplace may call a kit official, verified, unverified, first-party, or community-contributed. The runtime should still ask the same questions:

- Is the kit manifest valid?
- Are declared assets present and local to the kit?
- Are dependencies installed and activated?
- Are trigger fields structured and valid?
- Does evidence satisfy the active FlowDefinition gate?

The answer is determined by validation, activation, and gate evidence, not by a privileged kit list.

## The Portfolio Layer Doctrine

The engine/kits split here is Flow Agents' instance of the portfolio-wide **Layer Doctrine**
([surface/docs/architecture/portfolio-layer-doctrine.md](https://github.com/kontourai/surface/blob/main/docs/architecture/portfolio-layer-doctrine.md)):
dependency direction is one-way up the stack (open trust format → building-block tools → Surface →
products), and no layer reaches sideways into a peer. A product engine (e.g. `@kontourai/veritas`)
never depends on the platform, and a **kit consumes an engine only through its CLI + recorded
artifacts, never as an npm library import** — the whole point of the manifest/catalog model above.
Both edges are now enforced executably: veritas-side by `check-no-flow-agents-dep.mjs` (the engine
declares no flow-agents dependency) and here by [`scripts/check-layer-boundary.mjs`](../scripts/check-layer-boundary.mjs)
(no kit imports the veritas engine as a library). See veritas's
[Engine / Surface Seam](https://github.com/kontourai/veritas/blob/main/docs/architecture/engine-surface-seam.md)
for the canonical engine-vs-kit capability inventory maintained with that external kit.

## Related docs

- [Flow Kit Authoring Guide](kit-authoring-guide.md)
- [Flow Kit Repository Contract](flow-kit-repository-contract.md)
- [Runtime Hook Surface spec](spec/runtime-hook-surface.md)
- [Verifiable Trust](verifiable-trust.md)
- [Veritas Engine / Surface Seam](https://github.com/kontourai/veritas/blob/main/docs/architecture/engine-surface-seam.md) — how `@kontourai/veritas` splits into an engine library + the kit-owned product surface
- [Portfolio Layer Doctrine](https://github.com/kontourai/surface/blob/main/docs/architecture/portfolio-layer-doctrine.md)
